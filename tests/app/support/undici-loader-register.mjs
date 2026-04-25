import { register } from 'node:module';

register(new URL('./undici-loader.mjs', import.meta.url));
