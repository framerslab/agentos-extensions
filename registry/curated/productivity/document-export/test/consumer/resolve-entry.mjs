// Resolves and imports each specifier named on the command line the way a consumer's own `import` does. This file
// sits inside the package, so a specifier that names the package goes through its exports map (Node's package
// self-reference), the map an installed copy is resolved through. Prints one JSON line per specifier: the file it
// resolved to and the names its module exports.
for (const specifier of process.argv.slice(2)) {
  const url = import.meta.resolve(specifier);
  const names = Object.keys(await import(specifier)).sort();
  console.log(JSON.stringify({ specifier, url, names }));
}
