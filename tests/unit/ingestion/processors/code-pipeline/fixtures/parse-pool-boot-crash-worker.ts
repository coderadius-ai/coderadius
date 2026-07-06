/** Worker that dies before ever signaling readiness — exercises the
 *  pool's broken-environment fail-fast (two consecutive pre-ready deaths). */
process.exit(3);
