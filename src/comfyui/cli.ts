import { ComfyWorkflowCatalog } from './catalog';
import { ComfyService } from './service';

export async function comfyCommand(command: string | undefined, args: string[], output = (text: string) => console.log(text)): Promise<void> {
  const catalog = new ComfyWorkflowCatalog();
  if (command === 'status' && args.length === 0) {
    const result = await new ComfyService({ home: catalog.home }).call('comfyui_status', {});
    output(result.content.find((item) => item.type === 'text')?.text ?? '{}');
    return;
  }
  if (command === 'workflow' && args[0] === 'list' && args.length === 1) {
    output(JSON.stringify({ workflows: catalog.list() }, null, 2));
    return;
  }
  if (command === 'workflow' && args[0] === 'add' && args.length === 2) {
    output(JSON.stringify(catalog.add(args[1]), null, 2));
    return;
  }
  throw Error('Usage: isymcp comfy workflow add <workflow.json> | isymcp comfy workflow list | isymcp comfy status');
}
