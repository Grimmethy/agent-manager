/**
 * GameDesignForge Schema Definition
 *
 * Defines the schema for GameDesignForge, including design decision fields
 * that capture creative and architectural choices for game design documents.
 * The perspective field is a design decision that references the same enum
 * consumed by MechanicsForge and GameForge for consistency.
 */

/**
 * Available perspective enum values.
 * These correspond to the slugs defined in mechanicsforge/src/mechanics/perspectives.js
 * and the values consumed by gameforge/src/schema.js.
 */
const PERSPECTIVE_ENUM = {
  FIRST_PERSON: 'first-person',
  THIRD_PERSON: 'third-person',
  GOD_VIEW: 'god-view',
  ILLUSTRATED: 'illustrated'
};

/**
 * GameDesignForge schema definition.
 *
 * The perspective field is a design decision that captures the creative choice
 * about camera perspective for the game. It references the same enum values
 * consumed by MechanicsForge (for camera configuration) and GameForge (for
 * runtime implementation) to ensure consistency across the pipeline.
 *
 * Default: null (must be explicitly selected as a design decision)
 */
const GAMEDSIGNFORGE_SCHEMA = {
  perspective: {
    type: 'enum',
    values: Object.values(PERSPECTIVE_ENUM),
    default: null,
    required: true,
    category: 'design-decision',
    description: 'Design decision: camera perspective for the game. References the same enum values consumed by MechanicsForge and GameForge for consistency. This is a creative/architectural choice, not a runtime configuration.',
    references: {
      mechanicsForge: {
        source: 'mechanicsforge',
        file: 'src/mechanics/perspectives.js',
        field: 'PERSPECTIVES',
        note: 'MechanicsForge provides detailed camera and input configuration for each perspective slug'
      },
      gameForge: {
        source: 'gameforge',
        file: 'src/schema.js',
        field: 'perspective',
        note: 'GameForge consumes this design decision for runtime schema validation'
      }
    }
  }
};

module.exports = {
  PERSPECTIVE_ENUM,
  GAMEDSIGNFORGE_SCHEMA
};
