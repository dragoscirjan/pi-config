import Twig from 'twig';
import fs from 'fs';

const templateContent = fs.readFileSync('/home/dragosc/.pi/agent/skills/coding/SKILL.md.twig', 'utf-8');

const template = Twig.twig({
  data: templateContent
});

const rendered = template.render({
  context: {
    last_detected_language: "typescript"
  }
});

console.log(rendered);
