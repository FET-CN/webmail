# mailecho Webmail

The deployable `index.html` is generated from the files under `src/`.
The generated document deliberately keeps each CSS and JavaScript source in
its own readable inline block, annotated with `data-source`.

Build the single-file application with:

```sh
node scripts/build.mjs
```

Check that the generated file is current and that all JavaScript source files
parse successfully with:

```sh
node scripts/check-generated.mjs
```

Do not edit the generated `index.html` directly. The classic script order in
`scripts/build.mjs` is intentional and is part of the application runtime
contract.
