import { createTorboxClient, metadataFiles } from '../server/torbox.mjs';

try {
  const client = createTorboxClient(process.env.TORBOX_API_KEY);
  await client.account();
  console.log('TorBox authentication succeeded.');
  const files = metadataFiles(await client.list());
  console.log(`Combined Anna’s Archive metadata files available: ${files.filter((file) => file.ready).length}.`);
  // Never publish raw account responses, email, file names, API keys or download links.
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
