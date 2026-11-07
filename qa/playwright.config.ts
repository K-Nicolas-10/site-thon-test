import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    reporter: 'list',
    use: { baseURL: process.env.BASE_URL },
});
