export async function inspect(base) {
  const created = await fetch(base + '/exports', { method: 'POST', body: JSON.stringify({ requestKey: 'probe-only' }) });
  const job = await created.json();
  const manifest = await (await fetch(base + `/exports/${job.jobId}/manifest`)).json();
  const first = await fetch(new URL(manifest.files[0].url, base));
  return { job, manifest, firstFile: await first.text() };
}
