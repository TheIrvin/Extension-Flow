const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const event = () => ({addListener() {}});

for (const synchronous of [true, false]) {
  test(`invalidated extension stops cleanly (${synchronous ? 'synchronous throw' : 'rejected promise'})`, async () => {
    let sends = 0;
    const invalid = () => {
      const error = Error('Extension context invalidated.');
      if (synchronous) throw error;
      return Promise.reject(error);
    };
    const chrome = {
      storage:{local:{get:invalid,set:invalid}},
      runtime:{onMessage:event(),sendMessage:()=>{sends++;return invalid();}}
    };
    const context = vm.createContext({chrome,window:{},console:{warn(){}},setTimeout});
    const script = source('content.js').replace('  chrome.runtime.onMessage.addListener', '  window.testRunQueue = runQueue;\n  chrome.runtime.onMessage.addListener');
    vm.runInContext(script,context);
    await context.window.testRunQueue();
    assert.equal(sends,1);
    // The active flag was released even though both reporting and cleanup failed.
    await context.window.testRunQueue();
    assert.equal(sends,2);
  });
}

test('dedicated window moves the existing Flow tab without requesting focus or opening a URL', async () => {
  const calls = [];
  let current = {id: 3, state: 'normal', tabs: [{id:7}, {id:8}]};
  const chrome = {
    runtime: {onInstalled:event(), onMessage:event()},
    debugger: {onDetach:event()}, tabs: {onUpdated:event(), onRemoved:event()},
    windows: {get:async()=>current, create:async args=>calls.push(args), update:async(id,args)=>calls.push({id,...args})}
  };
  const context = vm.createContext({chrome,URL});
  vm.runInContext(source('background.js'), context);
  await vm.runInContext('prepareDedicatedWindow({id:7,windowId:3})',context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{tabId:7,type:'normal',focused:false,width:1100,height:850}]);
  calls.length = 0;
  current = {id:3,state:'normal',tabs:[{id:7}]};
  await vm.runInContext('prepareDedicatedWindow({id:7,windowId:3})',context);
  assert.equal(calls.length,0);
  current.state = 'minimized';
  await vm.runInContext('prepareDedicatedWindow({id:7,windowId:3})',context);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{id:3,state:'normal',focused:false}]);
});

test('queue enables focus emulation without selecting a tab, then restores it', async () => {
  const session = {}, commands = [];
  let attached = false;
  const chrome = {
    runtime: {onInstalled: event(), onMessage: event()},
    debugger: {onDetach: event(), getTargets: async () => [{tabId: 7, attached}],
      attach: async () => {attached = true;}, detach: async () => {attached = false;},
      sendCommand: async (target, name, args) => commands.push([target.tabId, name, args])},
    permissions: {contains: async () => true},
    tabs: {onUpdated: event(), onRemoved: event(), update() {throw Error('Must not activate Flow');}},
    storage: {session: {get: async () => ({...session}), set: async data => Object.assign(session, data), remove: async key => delete session[key]}}
  };
  const context = vm.createContext({chrome, URL});
  vm.runInContext(source('background.js'), context);
  await vm.runInContext('attachQueueDebugger(7)', context);
  await vm.runInContext('attachQueueDebugger(7)', context);
  assert.equal(attached, true);
  await vm.runInContext('detachQueueDebugger(7)', context);
  assert.equal(attached, false);
  assert.deepEqual(JSON.parse(JSON.stringify(commands)), [
    [7, 'Emulation.setFocusEmulationEnabled', {enabled: true}],
    [7, 'Emulation.setFocusEmulationEnabled', {enabled: true}],
    [7, 'Emulation.setFocusEmulationEnabled', {enabled: false}]
  ]);
});

test('two prompts save and advance before lazy images decode, after progress ends', async () => {
  let receive, now = 0, generated = 0, busyUntil = 0, finished;
  const completed = new Promise(resolve => {finished = resolve;});
  const writes = [], media = [], tileNodes = [];
  const data = {flowQueue: {items: [{prompt:'Primero',status:'pending'}, {prompt:'Segundo',status:'pending'}]}, flowDownloadSettings:{enabled:true,prefix:'test'}};
  class Input {
    get value() {return this.text || '';}
    set value(value) {this.text = value;}
    focus() {}
    hasAttribute() {return false;}
    dispatchEvent() {}
    getAttribute(name) {return name === 'placeholder' ? 'Describe' : null;}
    matches(selector) {return selector.includes('textarea');}
    getClientRects() {return [1];}
  }
  class Image {}
  const composer = Object.assign(new Input(), {isConnected:true, offsetWidth:200, tagName:'TEXTAREA'});
  const button = {innerText:'Generar',isConnected:true,offsetWidth:50,getAttribute:()=>null,getBoundingClientRect:()=>({left:1,top:1,width:50,height:50})};
  const root = {querySelectorAll:()=>media};
  const document = {
    body:{innerText:''},
    querySelector:()=>root,
    querySelectorAll: selector => {
      if (selector === 'flow-grid-tile-container') return tileNodes;
      if (selector.startsWith('textarea')) return [composer];
      if (selector.startsWith('button')) return [button];
      if (selector.startsWith('[aria-busy')) return now < busyUntil ? [button] : [];
      return [];
    }
  };
  const chrome = {storage:{local:{get:async()=>structuredClone(data),set:async patch=>Object.assign(data, structuredClone(patch))}},runtime:{onMessage:{addListener:fn=>{receive=fn;}},sendMessage:async message=>{
    if (message.type === 'FLOW_REAL_CLICK') {
      generated++;
      const generation = generated;
      composer.value = '';
      busyUntil = now + 1500;
      const tile = {getAttribute:()=>`Output ${generation}`};
      tileNodes.push(tile);
      media.push(Object.assign(new Image(), {currentSrc:'',complete:false,naturalWidth:0,naturalHeight:0,
        getAttribute:()=>`https://flow-content.google/image/${generation}`, closest:()=>tile}));
      return {ok:true};
    }
    if (message.type === 'FLOW_WRITE_OUTPUT') {
      assert.ok(now >= busyUntil, 'Must not save a partial generation');
      writes.push(message.url);
      return {ok:true,number:message.number,filename:`test${message.number}.png`};
    }
    if (message.type === 'FLOW_QUEUE_FINISH') finished();
    return {ok:true};
  }}};
  class Clock extends Date {static now() {return now;}}
  const context = vm.createContext({chrome,document,window:{},HTMLImageElement:Image,HTMLMediaElement:{HAVE_CURRENT_DATA:2},HTMLVideoElement:class {},Event:class {},URL,Date:Clock,crypto:require('node:crypto').webcrypto,setTimeout:(fn,ms)=>{now+=ms;return setImmediate(fn);}});
  vm.runInContext(source('content.js'), context);
  receive({type:'START_QUEUE'}, {}, ()=>{});
  await completed;
  assert.deepEqual(writes, ['https://flow-content.google/image/1','https://flow-content.google/image/2'], JSON.stringify(data.flowQueue));
  assert.ok(data.flowQueue.items.every(item => item.status === 'done'));
  assert.equal(data.flowQueue.running, false);
});


