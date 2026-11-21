import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** The repository root. */
export const root = fileURLToPath(new URL('../../', import.meta.url));

/** A program over `entries`, with the build config's compiler options. */
export function program(entries: readonly string[]): ts.Program {
  const configPath = `${root}tsconfig.build.json`;
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  return ts.createProgram(entries, { ...parsed.options, noEmit: true });
}

/** Every name a module exports, with the symbol each one resolves to. */
export function exportsOf(prog: ts.Program, file: string): Map<string, ts.Symbol> {
  const checker = prog.getTypeChecker();
  const source = prog.getSourceFile(file);
  if (source === undefined) throw new Error(`${file} is not in the program`);
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error(`${file} is not a module`);
  const result = new Map<string, ts.Symbol>();
  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const resolved =
      symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    result.set(symbol.getName(), resolved);
  }
  return result;
}
