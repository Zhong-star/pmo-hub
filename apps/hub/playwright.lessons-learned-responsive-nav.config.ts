import { defineConfig } from '@playwright/test';
import lessonsLearnedConfig from './playwright.lessons-learned.config';

export default defineConfig({
  ...lessonsLearnedConfig,
  testMatch: 'lessons-learned-responsive-nav.spec.ts',
});
