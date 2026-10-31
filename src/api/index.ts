import type { Backend } from './backend';
import { config } from '../config';
import { createDemoBackend } from './demoBackend';
import { createSupabaseBackend } from './supabaseBackend';

export const backend: Backend = config.demo
  ? createDemoBackend()
  : createSupabaseBackend(config.supabaseUrl, config.supabaseAnonKey);

export { BackendError } from './backend';
export type { Backend } from './backend';
