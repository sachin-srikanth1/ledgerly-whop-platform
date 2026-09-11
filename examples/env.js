"use strict";

/**
 * Load `.env` from the repo root if it exists, so every example picks up the
 * key the README tells you to put there. A missing file is fine: the examples
 * then explain which variable is unset.
 */
try {
  process.loadEnvFile();
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
