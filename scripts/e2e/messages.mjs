// Message-content assertions shared by the e2e steps. The unique text is a
// second argument so an older event from the same issuer cannot satisfy a
// check for a later message.
const MESSAGE_PREDICATE =
  "b4a.state.events.some((e) => e.type === 'message/text' && e.issuer === arg && e.text === arg2)";

export const gotText = (p, from, text) => p.get(MESSAGE_PREDICATE, from, text);

export const hasTextMessage = (p, from, text) =>
  p.get(MESSAGE_PREDICATE, from, text).then(Boolean);
