import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/** @type {import('@sveltejs/package').Config} */
const config = {
  preprocess: vitePreprocess()
};

export default config;
