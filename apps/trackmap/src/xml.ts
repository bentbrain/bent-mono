import { SaxesParser } from "saxes";

export interface XmlNode {
  name: string;
  text: string;
  attributes: Record<string, string>;
  children: XmlNode[];
}

/** Parse activity XML into plain data. No browser DOM or HTML sinks are used. */
export function parseActivityXml(source: string): XmlNode {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error("Activity XML cannot contain document types or entities.");
  const root: XmlNode = {
    name: "#document",
    text: "",
    attributes: {},
    children: [],
  };
  const stack = [root];
  const parser = new SaxesParser({ xmlns: true });
  parser.on("opentag", (tag) => {
    if (stack.length > 64)
      throw new Error("Activity XML nesting exceeds 64 levels.");
    const attributes: Record<string, string> = {};
    for (const attribute of Object.values(tag.attributes))
      attributes[attribute.local] = attribute.value;
    const node: XmlNode = {
      name: tag.local,
      text: "",
      attributes,
      children: [],
    };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  });
  const text = (value: string) => {
    stack[stack.length - 1].text += value;
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => {
    const node = stack.pop();
    if (node && stack.length) stack[stack.length - 1].text += node.text;
  });
  try {
    parser.write(source).close();
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("64 levels"))
      throw cause;
    throw new Error("This XML file is damaged. Export the activity again.");
  }
  return root;
}

export function xmlNodes(root: XmlNode, name: string): XmlNode[] {
  const matches: XmlNode[] = [];
  const pending = [...root.children].reverse();
  while (pending.length) {
    const node = pending.pop();
    if (!node) break;
    if (node.name === name) matches.push(node);
    for (let i = node.children.length - 1; i >= 0; i--)
      pending.push(node.children[i]);
  }
  return matches;
}
