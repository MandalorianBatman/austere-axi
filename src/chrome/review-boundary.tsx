// One panel that throws must not take the page down: each panel sits in its own boundary, and one more wraps the app.
// A boundary shows what failed and a Retry that draws the panel again; its siblings keep working.
import { Component } from "react";
import type { ErrorInfo, ReactElement, ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/chrome/ui/alert";
import { Button } from "@/chrome/ui/button";

interface Props {
  /** What the fallback calls the panel ("The notes"). */
  name: string;
  children: ReactNode;
}

export class PanelBoundary extends Component<Props, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      `austere: ${this.props.name} failed to draw: ${error.message}`,
      error,
      info.componentStack,
    );
  }

  override render(): ReactElement {
    const { error } = this.state;
    if (!error) return <>{this.props.children}</>;
    return (
      <Alert variant="destructive" data-boundary={this.props.name} className="my-1">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>{this.props.name} could not be drawn</AlertTitle>
        <AlertDescription>
          <p>Something went wrong. The rest of the page still works.</p>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
}
