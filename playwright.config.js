import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './test/browser',
    fullyParallel: false,
    workers: 1,
    use: {
        baseURL: 'http://127.0.0.1:4174',
        screenshot: 'only-on-failure',
    },
    projects: [
        { name: 'chromium', use: { browserName: 'chromium' } },
        { name: 'webkit', use: { browserName: 'webkit' } },
    ],
    webServer: {
        command: 'node scripts/serve-tests.js',
        url: 'http://127.0.0.1:4174',
        reuseExistingServer: true,
    },
});
