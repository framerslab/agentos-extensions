/**
 * @fileoverview Runs the account-source conformance suite inside a vitest case. The suite registers its cases with
 * `node:test`; a spec file mocks `node:test` with a registry's `test`, built in `vi.hoisted`, which collects them, and
 * {@link runConformance} registers a subject's cases and answers each case's outcome by its title.
 */
import { connectorConformance, type ConnectorConformanceSubject } from '../../../../../contracts/source-connectors/conformance.js';

/** One registered case: its title and its body. */
export interface RegisteredCase {
  readonly name: string;
  readonly work: () => Promise<void>;
}

/** The cases the mocked `node:test` collected, in registration order. */
export interface ConformanceRegistry {
  readonly cases: RegisteredCase[];
  /** Stands in for `node:test`'s `test(name, options, work)`. */
  test(name: string, options: unknown, work: () => Promise<void>): void;
}

/** What one registered case did: passed, or failed with its message. */
export type CaseOutcome = { readonly passed: true } | { readonly passed: false; readonly message: string };

/**
 * Registers a subject's conformance cases and runs each of them in turn.
 *
 * @param registry - The registry the spec file's mock of `node:test` fills.
 * @param subject - The connector's name, policy and case factory.
 * @returns Each case's outcome by its title, without the subject's name.
 */
export async function runConformance(registry: ConformanceRegistry,
  subject: ConnectorConformanceSubject): Promise<ReadonlyMap<string, CaseOutcome>> {
  const from = registry.cases.length;
  connectorConformance(subject);
  const outcomes = new Map<string, CaseOutcome>();
  for (const registered of registry.cases.slice(from)) {
    const title = registered.name.slice(subject.name.length + 2);
    try {
      await registered.work();
      outcomes.set(title, { passed: true });
    } catch (error) {
      outcomes.set(title, { passed: false, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}
