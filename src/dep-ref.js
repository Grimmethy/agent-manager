'use strict';

// Pure parser for dependency references. A dependency may be:
//   - a bare id string 'id'            -> resolved against currentProject (or null if omitted)
//   - a 'project:id' string            -> split on the FIRST colon only
//   - an object { project, id }        -> its fields are used as given
// A malformed qualified reference (empty side after split) throws.
// Anything else, or an empty project/id in the object form, yields null.

function parseDepRef(dep, currentProject) {
  if (typeof dep === 'string') {
    const i = dep.indexOf(':');
    if (i !== -1) {
      const project = dep.slice(0, i);
      const id = dep.slice(i + 1);
      if (!project || !id) {
        throw new Error(`parseDepRef: malformed qualified reference "${dep}"`);
      }
      return { project, id };
    }
    if (!dep) return null;
    if (typeof currentProject === 'string' && currentProject) {
      return { project: currentProject, id: dep };
    }
    return { project: null, id: dep };
  }
  if (dep !== null && typeof dep === 'object' && !Array.isArray(dep)) {
    const { project, id } = dep;
    if (typeof project !== 'string' || typeof id !== 'string') return null;
    if (!project || !id) return null;
    return { project, id };
  }
  return null;
}

module.exports = { parseDepRef };
