// Correr builds/tests como root deja dist/ y .test-state/ root:root y bloquea a las instancias.
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  console.error('PROHIBIDO correr suites o builds como root. Usa: su stev -c "umask 022 && ..."');
  process.exit(1);
}
