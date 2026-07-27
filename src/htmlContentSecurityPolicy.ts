import type { Element } from 'parse5';

type HtmlElement = Element;

function attribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((item) => item.name.toLowerCase() === name)?.value;
}

export function isEffectiveMetaContentSecurityPolicy(element: HtmlElement): boolean {
  const parent = element.parentNode;
  const content = attribute(element, 'content');
  return (
    element.tagName === 'meta' &&
    parent !== null &&
    'tagName' in parent &&
    parent.tagName === 'head' &&
    attribute(element, 'http-equiv')?.toLowerCase() === 'content-security-policy' &&
    content !== undefined &&
    content !== ''
  );
}
