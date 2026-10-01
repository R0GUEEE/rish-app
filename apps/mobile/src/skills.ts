/**
 * Skills: a reusable instruction document a person sends to the Agent.
 *
 * A skill is text, and using one is an explicit act: the manager puts it in
 * the message box, so it becomes a message the person can read and send. It is
 * deliberately not a hidden prefix on every round -- the visible history an
 * attempt may use is the conversation's own messages, so anything that
 * silently joined them would be a claim about what the Agent was told that no
 * transcript supports.
 */
export const MAX_SKILLS = 50;
export const MAX_SKILL_ID_LENGTH = 40;
export const MAX_SKILL_NAME_LENGTH = 60;
export const MAX_SKILL_VERSION_LENGTH = 32;
export const MAX_SKILL_DESCRIPTION_LENGTH = 512;
/** The longest instruction text; it becomes one message. */
export const MAX_SKILL_INSTRUCTIONS_LENGTH = 8192;

export type Skill = {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly instructions: string;
};

const SKILL_IDENTIFIER = /^[a-z][a-z0-9_]*$/u;

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= max &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

/** Instructions keep their newlines; only what renders as nothing is refused. */
function boundedInstructions(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= MAX_SKILL_INSTRUCTIONS_LENGTH &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  );
}

export function isSkillId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= MAX_SKILL_ID_LENGTH &&
    SKILL_IDENTIFIER.test(value)
  );
}

export function isSkillName(value: unknown): value is string {
  return boundedText(value, MAX_SKILL_NAME_LENGTH);
}

export function isSkillVersion(value: unknown): value is string {
  return boundedText(value, MAX_SKILL_VERSION_LENGTH);
}

export function isSkillDescription(value: unknown): value is string {
  return boundedText(value, MAX_SKILL_DESCRIPTION_LENGTH);
}

export function isSkillInstructions(value: unknown): value is string {
  return boundedInstructions(value);
}

export function isSkill(value: unknown): value is Skill {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== 5) return false;
  return (
    isSkillId(raw.id) &&
    isSkillName(raw.name) &&
    isSkillVersion(raw.version) &&
    isSkillDescription(raw.description) &&
    isSkillInstructions(raw.instructions)
  );
}

export function createSkill(input: {
  readonly id: unknown;
  readonly name: unknown;
  readonly version: unknown;
  readonly description: unknown;
  readonly instructions: unknown;
}): Skill | null {
  const candidate = {
    id: input.id,
    name: typeof input.name === 'string' ? input.name.trim() : input.name,
    version:
      typeof input.version === 'string' ? input.version.trim() : input.version,
    description:
      typeof input.description === 'string'
        ? input.description.trim()
        : input.description,
    instructions:
      typeof input.instructions === 'string'
        ? input.instructions.trim()
        : input.instructions,
  };
  return isSkill(candidate) ? (candidate as Skill) : null;
}

/** The whole list, or null when any entry is not a skill the app could keep. */
export function normalizeSkills(value: unknown): readonly Skill[] | null {
  if (!Array.isArray(value) || value.length > MAX_SKILLS) return null;
  const ids = new Set<string>();
  for (const entry of value) {
    if (!isSkill(entry)) return null;
    if (ids.has(entry.id)) return null;
    ids.add(entry.id);
  }
  return value as readonly Skill[];
}

export function findSkill(skills: readonly Skill[], id: string): Skill | null {
  return skills.find(skill => skill.id === id) ?? null;
}

/** Adds a skill, or replaces the one with the same id in place. */
export function upsertSkill(
  skills: readonly Skill[],
  skill: Skill,
): readonly Skill[] {
  if (!isSkill(skill)) return skills;
  const at = skills.findIndex(entry => entry.id === skill.id);
  if (at === -1) {
    return skills.length >= MAX_SKILLS ? skills : [...skills, skill];
  }
  if (skills[at] === skill) return skills;
  const next = [...skills];
  next[at] = skill;
  return next;
}

export function removeSkill(
  skills: readonly Skill[],
  id: string,
): readonly Skill[] {
  const next = skills.filter(skill => skill.id !== id);
  return next.length === skills.length ? skills : next;
}

/**
 * The message a skill becomes when it is used: the skill and its version on one
 * line, then the instructions as written. Nothing is added that the person did
 * not write.
 */
export function skillMessageText(skill: Skill): string {
  return `${skill.name} (skill ${skill.id} v${skill.version})\n\n${skill.instructions}`;
}
