import {
  MAX_SKILLS,
  MAX_SKILL_INSTRUCTIONS_LENGTH,
  createSkill,
  isSkill,
  isSkillId,
  normalizeSkills,
  removeSkill,
  skillMessageText,
  upsertSkill,
  type Skill,
} from '../src/skills';
import {
  createDefaultPreferences,
  createPreferencesStore,
  hydrateAppPreferences,
  preferencesReducer,
  selectSkills,
  serializeAppPreferences,
  type AppPreferences,
} from '../src/preferences';

const skill = (overrides: Partial<Skill> = {}): Skill =>
  createSkill({
    id: 'release_notes',
    name: 'Release notes',
    version: '1.0.0',
    description: 'Turn changes into notes.',
    instructions: 'Read the diff, then write the notes.',
    ...overrides,
  })!;

const setSkills = (
  preferences: AppPreferences,
  skills: readonly Skill[],
): AppPreferences =>
  preferencesReducer(preferences, {
    type: 'preferences/set-skills',
    payload: { skills },
  });

describe('skill declaration validation', () => {
  test('an id is short, lower case and usable as one', () => {
    expect(isSkillId('release_notes')).toBe(true);
    expect(isSkillId('Release')).toBe(false);
    expect(isSkillId('_leading')).toBe(false);
    expect(isSkillId('x'.repeat(41))).toBe(false);
  });

  test('instructions may keep their newlines but not control characters', () => {
    expect(
      isSkill({
        ...skill(),
        instructions: 'First line.\n\nSecond line.',
      }),
    ).toBe(true);
    // A tab is harmless in instruction text; what would render as nothing is not.
    expect(isSkill({ ...skill(), instructions: 'indented\tstep' })).toBe(true);
    expect(isSkill({ ...skill(), instructions: 'bell\u0007here' })).toBe(false);
    expect(
      isSkill({
        ...skill(),
        instructions: 'x'.repeat(MAX_SKILL_INSTRUCTIONS_LENGTH + 1),
      }),
    ).toBe(false);
  });

  test('creating trims what a person typed', () => {
    expect(
      createSkill({
        id: 'release_notes',
        name: '  Release notes  ',
        version: ' 1.0.0 ',
        description: '  Turn changes into notes.  ',
        instructions: '  Read the diff.  ',
      }),
    ).toEqual({
      id: 'release_notes',
      name: 'Release notes',
      version: '1.0.0',
      description: 'Turn changes into notes.',
      instructions: 'Read the diff.',
    });
  });

  test('the library is bounded and uniquely identified', () => {
    expect(normalizeSkills([skill()])).toHaveLength(1);
    expect(normalizeSkills([skill(), skill()])).toBeNull();
    expect(normalizeSkills([{ id: 'broken' }])).toBeNull();
    expect(normalizeSkills('skills')).toBeNull();
    expect(
      normalizeSkills(
        Array.from({ length: MAX_SKILLS + 1 }, (_, index) =>
          skill({ id: `s${index}` }),
        ),
      ),
    ).toBeNull();
  });

  test('adding replaces in place and refuses a new skill once full', () => {
    const list = upsertSkill(
      upsertSkill([], skill({ id: 'one' })),
      skill({ id: 'two' }),
    );
    const corrected = upsertSkill(list, skill({ id: 'one', version: '2.0.0' }));
    expect(corrected.map(entry => entry.id)).toEqual(['one', 'two']);
    expect(corrected[0]!.version).toBe('2.0.0');

    const full = Array.from({ length: MAX_SKILLS }, (_, index) =>
      skill({ id: `s${index}` }),
    );
    expect(upsertSkill(full, skill({ id: 'extra' }))).toBe(full);
    expect(removeSkill(full, 'missing')).toBe(full);
    expect(removeSkill(full, 's0')).toHaveLength(MAX_SKILLS - 1);
  });
});

describe('the message a skill becomes', () => {
  test('names the skill and keeps the instructions as written', () => {
    const text = skillMessageText(skill());
    expect(text.startsWith('Release notes (skill release_notes v1.0.0)')).toBe(
      true,
    );
    expect(text.endsWith('Read the diff, then write the notes.')).toBe(true);
  });
});

describe('skills as a preference', () => {
  test('starts with none and survives a save and load', () => {
    expect(selectSkills(createDefaultPreferences())).toEqual([]);
    const preferences = setSkills(createDefaultPreferences(), [skill()]);
    expect(
      selectSkills(hydrateAppPreferences(serializeAppPreferences(preferences))),
    ).toEqual(preferences.skills);
  });

  test('an equal-but-rebuilt list is not a change, and an invalid one is refused', () => {
    const preferences = setSkills(createDefaultPreferences(), [skill()]);
    expect(setSkills(preferences, [preferences.skills[0]!])).toBe(preferences);
    expect(
      preferencesReducer(preferences, {
        type: 'preferences/set-skills',
        payload: { skills: [{ id: 'broken' } as unknown as Skill] },
      }),
    ).toBe(preferences);
  });

  test('a state written before skills existed loads as none', () => {
    const serialized = JSON.parse(
      serializeAppPreferences(createDefaultPreferences()),
    ) as Record<string, unknown>;
    delete serialized.skills;
    expect(selectSkills(hydrateAppPreferences(serialized))).toEqual([]);
  });

  test('a stored list that breaks the rule is refused as a whole', () => {
    const withSkills = (value: unknown): Record<string, unknown> => {
      const serialized = JSON.parse(
        serializeAppPreferences(createDefaultPreferences()),
      ) as Record<string, unknown>;
      serialized.skills = value;
      return serialized;
    };
    expect(() => hydrateAppPreferences(withSkills([skill(), skill()]))).toThrow();
    expect(() => hydrateAppPreferences(withSkills([{ id: 'broken' }]))).toThrow();
    expect(selectSkills(hydrateAppPreferences(withSkills([])))).toEqual([]);
  });

  test('the store saves and removes without extra notifications', () => {
    const store = createPreferencesStore();
    const listener = jest.fn();
    store.subscribe(listener);
    const added = skill();

    store.saveSkill(added);
    store.saveSkill(added);
    store.deleteSkill('missing');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(selectSkills(store.getState())).toEqual([added]);

    store.deleteSkill(added.id);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(selectSkills(store.getState())).toEqual([]);
  });
});
