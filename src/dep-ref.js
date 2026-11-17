'use strict';

// Pure parser for dependency references. A dependency may be:
//   - a bare id string 'id'            -> resolved against currentProject
//   - a 'project:id' string            -> split on the FIRST colon only
//   - an object { project, id }        -> its fields are used as given
// Anything else, or an empty project/id, yields null.

function parseDepRef(dep, currentProject) {
  if (typeof dep === 'string') {
    const i = dep.indexOf(':');
    if (i !== -1) {
      const project = dep.slice(0, i);
      const id = dep.slice(i + 1);
      if (!project || !id) return null;
      return { project, id };
    }
    if (!dep || typeof currentProject !== 'string' || !currentProject) return null;
    return { project: currentProject, id: dep };
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
