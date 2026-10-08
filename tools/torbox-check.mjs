import { createTorboxClient, inspectMetadataAvailability } from '../server/torbox.mjs';

try {
  const client = createTorboxClient(process.env.TORBOX_API_KEY);
  await client.account();
  console.log('TorBox authentication succeeded.');
  const availability = await inspectMetadataAvailability(client);
  for (const collection of availability.collections) {
    console.log(`Anna metadata check (${collection.kind}): ${collection.status === 'checked' ? `${collection.ready} ready` : 'unavailable; not checked'}.`);
  }
  console.log(`Combined Anna’s Archive metadata files found in checked collections: ${availability.ready}.`);
  if (availability.collections.every((collection) => collection.status === 'unavailable')) {
    throw new Error('No TorBox collections could be checked; metadata availability is unknown.');
  }
  // Never publish raw account responses, email, file names, API keys or download links.
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
