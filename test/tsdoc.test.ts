import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { exportsOf, program, root } from './helpers/exports.js';

const ENTRIES = [
  `${root}src/index.ts`,
  `${root}src/testkit/index.ts`,
  `${root}src/persistence/index.ts`,
  `${root}src/node/sqlite/index.ts`,
  `${root}src/persistence/postgres/index.ts`,
  `${root}src/backstage/index.ts`,
  `${root}src/node/backstage/index.ts`,
  `${root}src/cluster/index.ts`,
  `${root}src/node/cluster/index.ts`,
];

function documented(symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  return (
    symbol.getDocumentationComment(checker).length > 0 || symbol.getJsDocTags(checker).length > 0
  );
}

/** The public members of an exported class or interface: no `#private` or `private` ones. */
function publicMembers(symbol: ts.Symbol): ts.Symbol[] {
  if (!(symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface))) return [];
  const members = [...(symbol.members?.values() ?? [])];
  return members.filter((member) => {
    const name = member.getName();
    if (name.startsWith('#') || name === '__constructor') return false;
    if (member.flags & ts.SymbolFlags.TypeParameter) return false;
    const modifiers = ts.getCombinedModifierFlags(member.declarations?.[0] as ts.Declaration);
    return !(modifiers & ts.ModifierFlags.Private);
  });
}

describe('TSDoc', () => {
  it('documents every public export and its public members', () => {
    const prog = program(ENTRIES);
    const checker = prog.getTypeChecker();
    const missing: string[] = [];
    for (const entry of ENTRIES) {
      for (const [name, symbol] of exportsOf(prog, entry)) {
        if (!documented(symbol, checker)) missing.push(name);
        for (const member of publicMembers(symbol)) {
          if (!documented(member, checker)) missing.push(`${name}.${member.getName()}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
