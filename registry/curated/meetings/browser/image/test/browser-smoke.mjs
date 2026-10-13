// The image workflow's check that the bot image's browser starts under the scheduler's container policy, before the
// lifecycle test: the workflow mounts this file over /app/dist/bot.js, so the image's own entrypoint starts PulseAudio
// and Xvfb as it does for a run, and this program launches Chromium as the bot does (headed, its own sandbox off,
// service workers blocked, the same flags). It opens no page. It prints that Chromium started, or Playwright's own
// error, which names what stopped the browser (a library it could not load, a call the container refused), and exits 1.
import { chromium } from 'playwright';

try {
  const context = await chromium.launchPersistentContext('/tmp/profile', {
    headless: false,
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--disable-dev-shm-usage', '--window-size=1280,720'],
    viewport: { width: 1280, height: 720 },
    permissions: ['microphone'],
    serviceWorkers: 'block',
    chromiumSandbox: false,
  });
  console.log(`Chromium started under the container policy (${context.pages().length} page open)`);
  await context.close();
} catch (err) {
  console.error(`Chromium did not start: ${String(err?.message ?? err).slice(0, 4000)}`);
  process.exitCode = 1;
}
