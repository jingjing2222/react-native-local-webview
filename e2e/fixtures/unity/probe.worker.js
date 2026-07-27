self.addEventListener('message', (event) => {
  if (event.data !== 'ping') return;
  self.postMessage({
    kind: 'pong',
    origin: self.location.origin,
  });
});
