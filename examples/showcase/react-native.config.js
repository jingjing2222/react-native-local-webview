const path = require('path');

module.exports = {
  project: {
    ios: {
      automaticPodsInstallation: true,
    },
  },
  dependencies: {
    'react-native-local-webview': {
      root: path.join(__dirname, '../../packages/react-native-local-webview'),
    },
  },
};
