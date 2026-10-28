/**
 * GameForge Schema Definition
 *
 * Defines the schema for GameForge, including the perspective field that
 * references MechanicsForge perspective entries. When generating game design
 * documents or scene graphs, GameForge pulls the perspective from MechanicsForge
 * to ensure consistency across the pipeline.
 */

/**
 * Available perspective enum values.
 * These correspond to the slugs defined in mechanicsforge/src/mechanics/perspectives.js.
 */
const PERSPECTIVE_ENUM = {
  FIRST_PERSON: 'first-person',
  THIRD_PERSON: 'third-person',
  GOD_VIEW: 'god-view',
  ILLUSTRATED: 'illustrated'
};

/**
 * GameForge schema definition.
 *
 * The perspective field references MechanicsForge perspective entries.
 * When generating game design documents or scene graphs, GameForge pulls
 * the perspective from MechanicsForge to ensure consistency.
 *
 * Default: null (must be explicitly selected)
 */
const GAMEFORGE_SCHEMA = {
  perspective: {
    type: 'enum',
    values: Object.values(PERSPECTIVE_ENUM),
    default: null,
    required: true,
    description: 'Camera perspective for the game. References MechanicsForge perspective entries. When generating game design documents or scene graphs, GameForge pulls the perspective from MechanicsForge to ensure consistency across the pipeline.',
    references: {
      source: 'mechanicsforge',
      file: 'src/mechanics/perspectives.js',
      field: 'PERSPECTIVES'
    }
  }
};

module.exports = {
  PERSPECTIVE_ENUM,
  GAMEFORGE_SCHEMA
};
