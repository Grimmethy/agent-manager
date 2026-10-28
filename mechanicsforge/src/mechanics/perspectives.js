/**
 * Perspective definitions for game camera and input systems.
 * Each perspective defines how the camera behaves and how user input is interpreted.
 */

const PERSPECTIVES = {
  firstPerson: {
    name: 'First Person',
    slug: 'first-person',
    description: 'Camera positioned at the character\'s eye level, providing an immersive view through the character\'s eyes. Movement and interaction are direct and immediate.',
    camera: {
      position: 'character-eyes',
      fov: 90,
      near: 0.1,
      far: 1000,
      lookAt: 'character-forward',
      constraints: {
        yaw: { min: -180, max: 180 },
        pitch: { min: -85, max: 85 },
        roll: 0
      }
    },
    inputHandling: {
      primary: 'mouse-look',
      secondary: 'keyboard-movement',
      notes: 'Mouse controls camera rotation, WASD controls movement relative to camera direction. Space for jump, shift for sprint.',
      sensitivity: {
        mouseX: 0.002,
        mouseY: 0.002
      }
    },
    assetReferences: {
      sceneForge: ['camera-rig-first-person', 'hud-overlay'],
      characterForge: ['character-eyes-model', 'hands-model']
    }
  },
  thirdPerson: {
    name: 'Third Person',
    slug: 'third-person',
    description: 'Camera positioned behind and above the character, providing a broader view of the environment while maintaining character visibility. Allows for better spatial awareness.',
    camera: {
      position: 'behind-character',
      distance: 3.5,
      height: 1.8,
      fov: 75,
      near: 0.1,
      far: 2000,
      lookAt: 'character-head',
      constraints: {
        yaw: { min: -180, max: 180 },
        pitch: { min: -30, max: 70 },
        roll: 0,
        distance: { min: 1.5, max: 8 }
      }
    },
    inputHandling: {
      primary: 'camera-orbit',
      secondary: 'character-movement',
      notes: 'Right stick or mouse for camera orbit, left stick for character movement. Camera can be manually adjusted or set to follow character direction.',
      sensitivity: {
        orbitSpeed: 0.003,
        followSpeed: 0.1
      }
    },
    assetReferences: {
      sceneForge: ['camera-rig-third-person', 'character-outline'],
      characterForge: ['character-model', 'character-animations']
    }
  },
  godView: {
    name: 'God View',
    slug: 'god-view',
    description: 'Top-down or isometric perspective providing a comprehensive view of the game world. Ideal for strategy games, RPGs, and tactical gameplay where spatial awareness is crucial.',
    camera: {
      position: 'high-angle',
      angle: 45,
      fov: 60,
      near: 0.5,
      far: 5000,
      lookAt: 'world-down',
      constraints: {
        yaw: { min: 0, max: 360 },
        pitch: { fixed: 45 },
        roll: { fixed: 0 },
        zoom: { min: 5, max: 50 }
      }
    },
    inputHandling: {
      primary: 'camera-zoom-pan',
      secondary: 'unit-selection',
      notes: 'Scroll wheel for zoom, edge scrolling or arrow keys for camera pan. Click to select units or interact with objects. No camera rotation needed.',
      sensitivity: {
        zoomSpeed: 0.1,
        panSpeed: 0.05
      }
    },
    assetReferences: {
      sceneForge: ['camera-rig-god-view', 'minimap', 'selection-indicators'],
      characterForge: ['unit-selection-outline', 'highlight-effects']
    }
  },
  illustrated: {
    name: 'Illustrated',
    slug: 'illustrated',
    description: 'Fixed camera angles with cinematic composition, similar to classic point-and-click or visual novel styles. Each scene has a carefully composed viewpoint that emphasizes storytelling and atmosphere.',
    camera: {
      position: 'fixed-scene',
      type: 'cinematic',
      fov: 50,
      near: 0.1,
      far: 1000,
      lookAt: 'scene-composition',
      constraints: {
        yaw: { fixed: 'per-scene' },
        pitch: { fixed: 'per-scene' },
        roll: { fixed: 0 },
        transitions: 'dissolve'
      }
    },
    inputHandling: {
      primary: 'point-click',
      secondary: 'dialogue-choice',
      notes: 'Mouse click to interact with objects or characters. Dialogue choices presented as UI elements. Camera changes are scripted transitions between fixed angles.',
      sensitivity: {
        clickRadius: 10,
        transitionSpeed: 1.5
      }
    },
    assetReferences: {
      sceneForge: ['camera-rig-illustrated', 'scene-compositions', 'transition-effects'],
      characterForge: ['character-portraits', 'expression-sheets']
    }
  }
};

module.exports = PERSPECTIVES;
