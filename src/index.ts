/** nostrwolfe-bridge entrypoint — startup ordering per the spec. */

export async function main(): Promise<void> {
  throw new Error("not implemented");
}

const isEntrypoint =
  process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);

if (isEntrypoint) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
