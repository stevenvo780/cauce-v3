#!/usr/bin/env node

if (process.env.NODE_ENV === 'production') {
  try {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is required');
    const url = new URL(connectionString);
    const mode = url.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? '';
    if (!['require', 'verify-ca', 'verify-full'].includes(mode)) {
      throw new Error('production PostgreSQL requires sslmode=require, verify-ca, or verify-full');
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'invalid production PostgreSQL TLS policy');
    process.exit(2);
  }
}
