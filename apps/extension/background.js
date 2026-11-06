import { createExtensionBridge } from './bridge.js';
const bridge = createExtensionBridge(chrome);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Only the packaged popup may initiate pairing. No content-script/external entry point.
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('popup.html')) return false;
  let action;
  if (message?.action === 'status') action = bridge.status();
  else if (message?.action === 'confirm') action = bridge.confirm(message.services);
  else if (message?.action === 'disconnect') action = Promise.resolve(bridge.disconnect());
  else if (message?.action === 'reset') action = bridge.resetProfile();
  else return false;
  action.then(result => respond({ ok: true, result })).catch(error => respond({ ok: false, code: error.code ?? 'BRIDGE_UNAVAILABLE' }));
  return true;
});
