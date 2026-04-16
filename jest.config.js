module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  testPathIgnorePatterns: ['<rootDir>/dist/'],
  moduleNameMapper: {
    '^@augmentcode/auggie-sdk$': '<rootDir>/src/__mocks__/@augmentcode/auggie-sdk.ts'
  }
};
