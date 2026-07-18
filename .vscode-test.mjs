import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'url';
import * as path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionDevelopmentPath = path.resolve(__dirname, '.');

// Use 'stable' by default to avoid repeated Insiders downloads.
// Override with: npm run test:insiders
// Or set: VSCODE_TEST_VERSION=insiders npm test
const version = process.env.VSCODE_TEST_VERSION || 'stable';

export default defineConfig({
    label: 'unit',
    files: 'out/test/**/*.test.js',
    version,
    workspaceFolder: extensionDevelopmentPath,
    mocha: {
        ui: 'tdd',
        timeout: 20000,
    },
    extensionDevelopmentPath,
});
