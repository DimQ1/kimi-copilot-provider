import * as vscode from 'vscode';

// ═══════════════════════════════════════════════════════════════════════
// Command — GoF Command Pattern base
//
// Each VS Code command is encapsulated as a class with a single execute()
// method and a register() hook for wiring into the extension lifecycle.
// ═══════════════════════════════════════════════════════════════════════

export interface Command {
	readonly id: string;
	execute(): void | Promise<void>;
	register(context: vscode.ExtensionContext): void;
}

/** Convenience base: wires vscode.commands.registerCommand to execute(). */
export abstract class BaseCommand implements Command {
	abstract readonly id: string;
	abstract execute(): void | Promise<void>;

	register(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.commands.registerCommand(this.id, () => this.execute()),
		);
	}
}
