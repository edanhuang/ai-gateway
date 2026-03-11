#!/usr/bin/env node

const prompt = process.argv[process.argv.length - 1] || "";
const chunks = [`Echo: ${prompt.slice(0, 24)}`, " ::done"];
let index = 0;

function emitNext() {
  if (index >= chunks.length) {
    process.exit(0);
  }

  process.stdout.write(`${JSON.stringify({ type: "delta", delta: chunks[index] })}\n`);
  index += 1;
  setTimeout(emitNext, 50);
}

emitNext();
