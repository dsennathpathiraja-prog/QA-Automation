/**
 * Runner entry: reachability check (Phase 5) or work-item case run (Phase 7).
 * bundleRef selects the script; the launcher always starts this image.
 */
const bundle = process.env.QA_BUNDLE_REF ?? 'reachability';
if (bundle === 'work-item' || bundle === 'playwright') {
  await import('./execute.mjs');
} else {
  await import('./check.mjs');
}
