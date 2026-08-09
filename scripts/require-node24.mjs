const [major] = process.versions.node.split('.').map(Number);

if (major !== 24) {
  console.error(`AIMuse requires Node.js 24.x; this process is Node.js ${process.versions.node}. Use .nvmrc or another Node 24 runtime.`);
  process.exit(1);
}

