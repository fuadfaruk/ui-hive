import { EncryptedConnectionStore } from '../server/connection.js';
import { saved } from './helpers.js';

const [path, action] = process.argv.slice(2);
if (!path) throw new Error('A disposable storage path is required.');
const store = new EncryptedConnectionStore(path);
if (action === 'write') {
  await store.write(saved);
} else if (action === 'replace') {
  await store.write({ ...saved, key: 'fake-dpapi-replacement', settings: { ...saved.settings, model: 'replacement-model' } });
} else if (action === 'read') {
  const record = await store.read();
  if (record?.key !== saved.key || record.settings.model !== saved.settings.model) throw new Error('Restart round-trip failed.');
} else if (action === 'read-replacement') {
  const record = await store.read();
  if (record?.key !== 'fake-dpapi-replacement' || record.settings.model !== 'replacement-model') throw new Error('Replacement round-trip failed.');
} else if (action === 'forget') {
  await store.forget();
  if (await store.read() !== null) throw new Error('Deletion failed.');
} else {
  throw new Error('Unknown validation operation.');
}
console.log(`DPAPI ${action} passed.`);
