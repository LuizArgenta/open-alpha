/**
 * Graph checks for authored curriculum, applied before anything is published.
 *
 * The same rules curriculum/validate.js applies to files, expressed over the
 * graph rather than over a directory, because an authoring interface can
 * produce a broken graph in a click and there is no pull request in the way.
 *
 * A cycle is the one that matters most: the engine walks prerequisites to
 * find what a student is missing, and a cycle makes that walk run forever.
 */

export interface ValidatableConcept {
  id: string;
  name: string;
  level: number;
  prerequisites: string[];
}

export interface GraphProblem {
  conceptId: string;
  code: 'missing_prerequisite' | 'cycle' | 'level_inversion' | 'self_prerequisite' | 'duplicate_id';
  detail: string;
}

export function validateConceptGraph(concepts: ValidatableConcept[]): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const byId = new Map<string, ValidatableConcept>();

  for (const concept of concepts) {
    if (byId.has(concept.id)) {
      problems.push({
        conceptId: concept.id,
        code: 'duplicate_id',
        detail: `More than one concept uses the id "${concept.id}"`,
      });
      continue;
    }
    byId.set(concept.id, concept);
  }

  for (const concept of byId.values()) {
    for (const prerequisiteId of concept.prerequisites) {
      if (prerequisiteId === concept.id) {
        problems.push({
          conceptId: concept.id,
          code: 'self_prerequisite',
          detail: `"${concept.name}" lists itself as a prerequisite`,
        });
        continue;
      }

      const prerequisite = byId.get(prerequisiteId);
      if (!prerequisite) {
        problems.push({
          conceptId: concept.id,
          code: 'missing_prerequisite',
          detail: `"${concept.name}" requires "${prerequisiteId}", which does not exist`,
        });
        continue;
      }

      if (prerequisite.level > concept.level) {
        problems.push({
          conceptId: concept.id,
          code: 'level_inversion',
          detail: `"${concept.name}" (level ${concept.level}) requires "${prerequisite.name}" at a higher level (${prerequisite.level})`,
        });
      }
    }
  }

  for (const cycle of findCycles(byId)) {
    problems.push({
      conceptId: cycle[0],
      code: 'cycle',
      detail: `Prerequisites form a loop: ${cycle.join(' → ')}`,
    });
  }

  return problems;
}

function findCycles(byId: Map<string, ValidatableConcept>): string[][] {
  const cycles: string[][] = [];
  const settled = new Set<string>();
  const onPath = new Set<string>();
  const reported = new Set<string>();

  function walk(id: string, path: string[]): void {
    if (onPath.has(id)) {
      const cycle = [...path.slice(path.indexOf(id)), id];
      // One report per loop, whichever node reached it first.
      const signature = [...cycle].sort().join('|');
      if (!reported.has(signature)) {
        reported.add(signature);
        cycles.push(cycle);
      }
      return;
    }
    if (settled.has(id)) return;

    onPath.add(id);
    path.push(id);

    for (const prerequisiteId of byId.get(id)?.prerequisites ?? []) {
      if (byId.has(prerequisiteId)) walk(prerequisiteId, path);
    }

    path.pop();
    onPath.delete(id);
    settled.add(id);
  }

  for (const id of byId.keys()) walk(id, []);

  return cycles;
}
