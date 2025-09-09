module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/.tests'],
  testMatch: ['**/.tests/**/*.test.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFilesAfterEnv: ['<rootDir>/.tests/setup.ts'],
  moduleNameMapper: {
    '^vscode$': '<rootDir>/.tests/vscode-mock.ts',
    '^sqlite3$': '<rootDir>/.tests/sqlite3-mock.ts',
    '^../src/core/ai-lens$': '<rootDir>/.tests/ai-analyzer-mock.ts',
    '^../src/runtime/document-monitor$': '<rootDir>/.tests/document-monitor-mock.ts',
    '^../src/ui/dashboard-webview$': '<rootDir>/.tests/dashboard-mock.ts'
  }
};
