/********************************************************************************
 * Copyright (C) 2018-2019 TypeFox and others.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0.
 *
 * This Source Code may also be made available under the following Secondary
 * Licenses when the conditions for such availability set forth in the Eclipse
 * Public License v. 2.0 are satisfied: GNU General Public License, version 2
 * with the GNU Classpath Exception which is available at
 * https://www.gnu.org/software/classpath/license.html.
 *
 * SPDX-License-Identifier: EPL-2.0 OR GPL-2.0 WITH Classpath-exception-2.0
 ********************************************************************************/

import { interfaces, injectable, inject } from 'inversify';
import { v4 } from 'uuid';
import { IIterator, toArray, find, some, every, map } from '@phosphor/algorithm';
import {
    Widget, EXPANSION_TOGGLE_CLASS, COLLAPSED_CLASS, MessageLoop, Message, SplitPanel, BaseWidget,
    addEventListener, SplitLayout, LayoutItem
} from './widgets';
import { Event, Emitter } from '../common/event';
import { Deferred } from '../common/promise-util';
import { Disposable, DisposableCollection } from '../common/disposable';
import { CommandRegistry } from '../common/command';
import { MenuModelRegistry, MenuPath } from '../common/menu';
import { ApplicationShell, StatefulWidget, SplitPositionHandler, SplitPositionOptions } from './shell';
import { MAIN_AREA_ID, BOTTOM_AREA_ID } from './shell/theia-dock-panel';
import { FrontendApplicationStateService } from './frontend-application-state';
import { ContextMenuRenderer, Anchor } from './context-menu-renderer';
import { parseCssMagnitude } from './browser';
import { WidgetManager } from './widget-manager';

/**
 * A view container holds an arbitrary number of widgets inside a split panel.
 * Each widget is wrapped in a _part_ that displays the widget title and toolbar
 * and allows to collapse / expand the widget content.
 */
export class ViewContainer extends BaseWidget implements StatefulWidget, ApplicationShell.TrackableWidgetProvider {

    protected readonly panel: SplitPanel;
    protected readonly attached = new Deferred<void>();

    constructor(protected readonly services: ViewContainer.Services, ...inputs: { widget: Widget, options?: ViewContainer.Factory.WidgetOptions }[]) {
        super();
        this.id = `view-container-widget-${v4()}`;
        this.addClass('theia-view-container');
        const layout = new ViewContainerLayout({
            renderer: SplitPanel.defaultRenderer,
            orientation: this.orientation,
            spacing: 2,
            headerSize: ViewContainerPart.HEADER_HEIGHT,
            animationDuration: 200
        }, services.splitPositionHandler);
        this.panel = new SplitPanel({ layout });
        for (const { widget, options } of inputs) {
            this.addWidget(widget, options);
        }
        this.attached.promise.then(() => {
            this.layout.setPartSizes(inputs.map(({ options }) => options ? options.weight : undefined));
        });

        const { commandRegistry, menuRegistry, contextMenuRenderer } = this.services;
        commandRegistry.registerCommand({ id: this.globalHideCommandId }, {
            execute: (anchor: Anchor) => {
                const toHide = this.findPartForAnchor(anchor);
                if (toHide && toHide.canHide) {
                    toHide.hide();
                }
            },
            isVisible: (anchor: Anchor) => {
                const toHide = this.findPartForAnchor(anchor);
                if (toHide) {
                    return toHide.canHide && !toHide.isHidden;
                } else {
                    return some(this.layout.iter(), part => !part.isHidden);
                }
            }
        });
        menuRegistry.registerMenuAction([...this.contextMenuPath, '0_global'], {
            commandId: this.globalHideCommandId,
            label: 'Hide'
        });
        this.toDispose.pushAll([
            addEventListener(this.node, 'contextmenu', event => {
                if (event.button === 2 && every(this.layout.iter(), part => !!part.isHidden)) {
                    event.stopPropagation();
                    event.preventDefault();
                    contextMenuRenderer.render({ menuPath: this.contextMenuPath, anchor: event });
                }
            }),
            Disposable.create(() => commandRegistry.unregisterCommand(this.globalHideCommandId)),
            Disposable.create(() => menuRegistry.unregisterMenuAction(this.globalHideCommandId))
        ]);
    }

    protected findPartForAnchor(anchor: Anchor): ViewContainerPart | undefined {
        const element = document.elementFromPoint(anchor.x, anchor.y);
        if (element instanceof Element) {
            const closestPart = ViewContainerPart.closestPart(element);
            if (closestPart && closestPart.id) {
                return find(this.layout.iter(), part => part.id === closestPart.id);
            }
        }
        return undefined;
    }

    addWidget(widget: Widget, options?: ViewContainer.Factory.WidgetOptions): Disposable {
        if (find(this.layout.iter(), ({ wrapped }) => wrapped.id === widget.id)) {
            return Disposable.NULL;
        }
        const description = this.services.widgetManager.getDescription(widget);
        const partId = description ? JSON.stringify(description) : widget.id;
        const newPart = new ViewContainerPart(widget, partId, this.id, options);
        this.registerPart(newPart);
        if (options && options.order !== undefined) {
            const index = this.layout.widgets.findIndex(part => part.options.order === undefined || part.options.order > options.order!);
            if (index >= 0) {
                this.layout.insertWidget(index, newPart);
            } else {
                this.layout.addWidget(newPart);
            }
        } else {
            this.layout.addWidget(newPart);
        }
        this.refreshMenu(newPart);
        this.update();
        return new DisposableCollection(
            Disposable.create(() => this.removeWidget(widget)),
            newPart.onCollapsed(() => this.layout.updateCollapsed(newPart, this.enableAnimation)),
            newPart.onMoveBefore(toMoveId => this.moveBefore(toMoveId, newPart.id)),
            newPart.onContextMenu(event => {
                if (event.button === 2) {
                    event.preventDefault();
                    event.stopPropagation();
                    const { contextMenuRenderer } = this.services;
                    contextMenuRenderer.render({ menuPath: this.contextMenuPath, anchor: event });
                }
            })
        );
    }

    removeWidget(widget: Widget): boolean {
        const part = find(this.layout.iter(), ({ wrapped }) => wrapped.id === widget.id);
        if (!part) {
            return false;
        }
        this.unregisterPart(part);
        this.layout.removeWidget(part);
        this.update();
        return true;
    }

    getTrackableWidgets(): ViewContainerPart[] {
        return this.layout.widgets;
    }

    get layout(): ViewContainerLayout {
        return this.panel.layout as ViewContainerLayout;
    }

    protected get orientation(): SplitLayout.Orientation {
        return ViewContainer.getOrientation(this.node);
    }

    protected get enableAnimation(): boolean {
        return this.services.applicationStateService.state === 'ready';
    }

    storeState(): ViewContainer.State {
        const parts = this.layout.widgets;
        const availableSize = this.layout.getAvailableSize();
        const orientation = this.orientation;
        const partStates = parts.map(part => {
            let size = this.layout.getPartSize(part);
            if (size && size > ViewContainerPart.HEADER_HEIGHT && orientation === 'vertical') {
                size -= ViewContainerPart.HEADER_HEIGHT;
            }
            return <ViewContainerPart.State>{
                partId: part.partId,
                collapsed: part.collapsed,
                hidden: part.isHidden,
                relativeSize: size && availableSize ? size / availableSize : undefined
            };
        });
        return { parts: partStates };
    }

    /**
     * The view container restores the visibility, order and relative sizes of contained
     * widgets, but _not_ the widgets themselves. In case the set of widgets is not fixed,
     * it should be restored in the specific subclass or in the widget holding the view container.
     */
    restoreState(state: ViewContainer.State): void {
        if (state.parts) {
            const partStates = state.parts.filter(partState => some(this.layout.iter(), p => p.partId === partState.partId));

            // Reorder the parts according to the stored state
            for (let index = 0; index < partStates.length; index++) {
                const partState = partStates[index];
                const currentIndex = this.layout.widgets.findIndex(p => p.partId === partState.partId);
                if (currentIndex > index) {
                    this.layout.moveWidget(currentIndex, index);
                }
            }

            // Restore visibility and collapsed state
            const parts = this.layout.widgets;
            for (let index = 0; index < parts.length; index++) {
                const part = parts[index];
                const partState = partStates.find(s => part.partId === s.partId);
                if (partState) {
                    part.collapsed = partState.collapsed || !partState.relativeSize;
                    if (part.canHide) {
                        part.setHidden(partState.hidden);
                    }
                } else if (part.canHide) {
                    part.hide();
                }
                this.refreshMenu(part);
            }

            // Restore part sizes
            this.attached.promise.then(() => {
                this.layout.setPartSizes(partStates.map(partState => partState.relativeSize));
            });
        }
    }

    /**
     * Register a command to toggle the visibility of the new part.
     */
    protected registerPart(toRegister: ViewContainerPart): void {
        if (toRegister.canHide) {
            const { commandRegistry } = this.services;
            const commandId = this.toggleVisibilityCommandId(toRegister);
            commandRegistry.registerCommand({ id: commandId }, {
                execute: () => {
                    const toHide = find(this.layout.iter(), part => part.id === toRegister.id);
                    if (toHide) {
                        this.toggleVisibility(toHide);
                    }
                },
                isToggled: () => {
                    const widgetToToggle = find(this.layout.iter(), part => part.id === toRegister.id);
                    if (widgetToToggle) {
                        return !widgetToToggle.isHidden;
                    }
                    return false;
                }
            });
        }
    }

    /**
     * Register a menu action to toggle the visibility of the new part.
     * The menu action is unregistered first to enable refreshing the order of menu actions.
     */
    protected refreshMenu(part: ViewContainerPart) {
        if (part.canHide) {
            const { menuRegistry } = this.services;
            const commandId = this.toggleVisibilityCommandId(part);
            menuRegistry.unregisterMenuAction(commandId);
            menuRegistry.registerMenuAction([...this.contextMenuPath, '1_widgets'], {
                commandId: commandId,
                label: part.wrapped.title.label,
                order: this.layout.widgets.indexOf(part).toString()
            });
        }
    }

    protected unregisterPart(part: ViewContainerPart): void {
        const { commandRegistry, menuRegistry } = this.services;
        const commandId = this.toggleVisibilityCommandId(part);
        commandRegistry.unregisterCommand(commandId);
        menuRegistry.unregisterMenuAction(commandId);
    }

    protected get contextMenuPath(): MenuPath {
        return [`${this.id}-context-menu`];
    }

    protected toggleVisibilityCommandId(part: ViewContainerPart): string {
        return `${this.id}:toggle-visibility-${part.id}`;
    }

    protected get globalHideCommandId(): string {
        return `${this.id}:toggle-visibility`;
    }

    protected toggleVisibility(part: ViewContainerPart): void {
        if (part.canHide) {
            part.setHidden(!part.isHidden);
            if (!part.isHidden) {
                part.collapsed = false;
            }
        }
    }

    protected moveBefore(toMovedId: string, moveBeforeThisId: string): void {
        const parts = this.layout.widgets;
        const toMoveIndex = parts.findIndex(part => part.id === toMovedId);
        const moveBeforeThisIndex = parts.findIndex(part => part.id === moveBeforeThisId);
        if (toMoveIndex >= 0 && moveBeforeThisIndex >= 0) {
            this.layout.moveWidget(toMoveIndex, moveBeforeThisIndex);
            for (let index = Math.min(toMoveIndex, moveBeforeThisIndex); index < parts.length; index++) {
                this.refreshMenu(parts[index]);
            }
        }
    }

    protected onResize(msg: Widget.ResizeMessage): void {
        for (const widget of [this.panel, ...this.layout.widgets]) {
            MessageLoop.sendMessage(widget, Widget.ResizeMessage.UnknownSize);
        }
        super.onResize(msg);
    }

    protected onUpdateRequest(msg: Message): void {
        for (const widget of [this.panel, ...this.layout.widgets]) {
            widget.update();
        }
        super.onUpdateRequest(msg);
    }

    protected onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.panel.activate();
    }

    protected onAfterAttach(msg: Message): void {
        const orientation = this.orientation;
        this.layout.orientation = orientation;
        if (orientation === 'horizontal') {
            for (const part of this.layout.widgets) {
                part.collapsed = false;
            }
        }
        if (!this.panel.isAttached) {
            Widget.attach(this.panel, this.node);
        }
        super.onAfterAttach(msg);
        requestAnimationFrame(() => this.attached.resolve());
    }

}

export namespace ViewContainer {

    @injectable()
    export class Services {
        @inject(FrontendApplicationStateService)
        readonly applicationStateService: FrontendApplicationStateService;
        @inject(ContextMenuRenderer)
        readonly contextMenuRenderer: ContextMenuRenderer;
        @inject(CommandRegistry)
        readonly commandRegistry: CommandRegistry;
        @inject(MenuModelRegistry)
        readonly menuRegistry: MenuModelRegistry;
        @inject(WidgetManager)
        readonly widgetManager: WidgetManager;
        @inject(SplitPositionHandler)
        readonly splitPositionHandler: SplitPositionHandler;
    }

    export const Factory = Symbol('ViewContainerFactory');
    export interface Factory {
        (...widgets: Factory.WidgetDescriptor[]): ViewContainer;
    }

    export namespace Factory {

        export interface WidgetOptions {
            readonly order?: number;
            readonly weight?: number;
            readonly initiallyCollapsed?: boolean;
            readonly canHide?: boolean;
            readonly initiallyHidden?: boolean;
        }

        export interface WidgetDescriptor {
            readonly widget: Widget | interfaces.ServiceIdentifier<Widget>;
            readonly options?: WidgetOptions;
        }

    }

    export interface State {
        parts: ViewContainerPart.State[]
    }

    export function getOrientation(node: HTMLElement): 'horizontal' | 'vertical' {
        if (node.closest(`#${MAIN_AREA_ID}`) || node.closest(`#${BOTTOM_AREA_ID}`)) {
            return 'horizontal';
        }
        return 'vertical';
    }
}

/**
 * Wrapper around a widget held by a view container. Adds a header to display the
 * title, toolbar, and collapse / expand handle.
 */
export class ViewContainerPart extends BaseWidget {

    protected readonly header: HTMLElement;
    protected readonly body: HTMLElement;
    protected readonly collapsedEmitter = new Emitter<boolean>();
    protected readonly moveBeforeEmitter = new Emitter<string>();
    protected readonly contextMenuEmitter = new Emitter<MouseEvent>();

    protected _collapsed: boolean;
    /**
     * Self cannot be a drop target. When the drag event starts, we disable the current part as a possible drop target.
     *
     * This is a workaround for not being able to sniff into the `event.dataTransfer.getData` value when `dragover` due to security reasons.
     */
    private canBeDropTarget = true;

    uncollapsedSize: number | undefined;
    animatedSize: number | undefined;

    constructor(
        public readonly wrapped: Widget,
        public readonly partId: string,
        viewContainerId: string,
        public readonly options: ViewContainer.Factory.WidgetOptions = {}
    ) {
        super();
        this.id = `${viewContainerId}--${wrapped.id}`;
        this.addClass('part');
        const { header, body, disposable } = this.createContent();
        this.header = header;
        this.body = body;
        this.toDispose.pushAll([
            disposable,
            this.collapsedEmitter,
            this.moveBeforeEmitter,
            this.contextMenuEmitter,
            this.registerDND(),
            this.registerContextMenu()
        ]);
        this.scrollOptions = {
            suppressScrollX: true,
            minScrollbarLength: 35
        };
        this.node.tabIndex = 0;
        this.collapsed = !!options.initiallyCollapsed;
        if (options.initiallyHidden && this.canHide) {
            this.hide();
        }
    }

    get collapsed(): boolean {
        return this._collapsed;
    }

    set collapsed(collapsed: boolean) {
        // Cannot collapse/expand if the orientation of the container is `horizontal`.
        const orientation = ViewContainer.getOrientation(this.node);
        if (this._collapsed === collapsed || orientation === 'horizontal' && collapsed) {
            return;
        }
        this._collapsed = collapsed;
        this.body.style.display = collapsed ? 'none' : 'block';
        const toggleIcon = this.header.querySelector(`span.${EXPANSION_TOGGLE_CLASS}`);
        if (toggleIcon) {
            if (collapsed) {
                toggleIcon.classList.add(COLLAPSED_CLASS);
            } else {
                toggleIcon.classList.remove(COLLAPSED_CLASS);
            }
        }
        this.update();
        this.collapsedEmitter.fire(collapsed);
    }

    get canHide() {
        return this.options.canHide === undefined || this.options.canHide;
    }

    get onCollapsed(): Event<boolean> {
        return this.collapsedEmitter.event;
    }

    get onMoveBefore(): Event<string> {
        return this.moveBeforeEmitter.event;
    }

    get onContextMenu(): Event<MouseEvent> {
        return this.contextMenuEmitter.event;
    }

    get minSize(): number {
        const style = getComputedStyle(this.body);
        if (ViewContainer.getOrientation(this.node) === 'horizontal') {
            return parseCssMagnitude(style.minWidth, 0);
        } else {
            return parseCssMagnitude(style.minHeight, 0);
        }
    }

    protected getScrollContainer(): HTMLElement {
        return this.body;
    }

    protected registerContextMenu(): Disposable {
        return new DisposableCollection(
            addEventListener(this.header, 'contextmenu', event => {
                this.contextMenuEmitter.fire(event);
            })
        );
    }

    protected registerDND(): Disposable {
        this.header.draggable = true;
        const style = (event: DragEvent) => {
            event.preventDefault();
            const part = ViewContainerPart.closestPart(event.target);
            if (part instanceof HTMLElement) {
                if (this.canBeDropTarget) {
                    part.classList.add('drop-target');
                }
            }
        };
        const unstyle = (event: DragEvent) => {
            event.preventDefault();
            const part = ViewContainerPart.closestPart(event.target);
            if (part instanceof HTMLElement) {
                part.classList.remove('drop-target');
            }
        };
        return new DisposableCollection(
            addEventListener(this.header, 'dragstart', event => {
                const { dataTransfer } = event;
                if (dataTransfer) {
                    this.canBeDropTarget = false;
                    dataTransfer.effectAllowed = 'move';
                    dataTransfer.setData('view-container-dnd', this.id);
                    const dragImage = document.createElement('div');
                    dragImage.classList.add('theia-view-container-drag-image');
                    dragImage.innerText = this.wrapped.title.label;
                    document.body.appendChild(dragImage);
                    dataTransfer.setDragImage(dragImage, -10, -10);
                    setTimeout(() => document.body.removeChild(dragImage), 0);
                }
            }, false),
            addEventListener(this.node, 'dragend', () => this.canBeDropTarget = true, false),
            addEventListener(this.node, 'dragover', style, false),
            addEventListener(this.node, 'dragleave', unstyle, false),
            addEventListener(this.node, 'drop', event => {
                const { dataTransfer } = event;
                if (dataTransfer) {
                    const moveId = dataTransfer.getData('view-container-dnd');
                    if (moveId && moveId !== this.id) {
                        this.moveBeforeEmitter.fire(moveId);
                    }
                    unstyle(event);
                }
            }, false)
        );
    }

    protected createContent(): { header: HTMLElement, body: HTMLElement, disposable: Disposable } {
        const disposable = new DisposableCollection();
        const { header, disposable: headerDisposable } = this.createHeader();
        const body = document.createElement('div');
        body.classList.add('body');
        this.node.appendChild(header);
        this.node.appendChild(body);
        disposable.push(headerDisposable);
        return {
            header,
            body,
            disposable,
        };
    }

    protected createHeader(): { header: HTMLElement, disposable: Disposable } {
        const disposable = new DisposableCollection();
        const header = document.createElement('div');
        header.classList.add('theia-header', 'header');
        disposable.push(addEventListener(header, 'click', () => {
            this.collapsed = !this.collapsed;
        }));

        const toggleIcon = document.createElement('span');
        toggleIcon.classList.add(EXPANSION_TOGGLE_CLASS);
        if (this.collapsed) {
            toggleIcon.classList.add(COLLAPSED_CLASS);
        }
        header.appendChild(toggleIcon);

        const title = document.createElement('span');
        title.classList.add('label', 'noselect');
        title.innerText = this.wrapped.title.label;
        header.appendChild(title);

        if (ViewContainerPart.ContainedWidget.is(this.wrapped)) {
            for (const { tooltip, execute, className } of this.wrapped.toolbarElements.filter(e => e.enabled !== false)) {
                const toolbarItem = document.createElement('span');
                toolbarItem.classList.add('element');
                if (typeof className === 'string') {
                    toolbarItem.classList.add(...className.split(' '));
                } else if (Array.isArray(className)) {
                    className.forEach(a => toolbarItem.classList.add(...a.split(' ')));
                }
                toolbarItem.title = tooltip;
                disposable.push(addEventListener(toolbarItem, 'click', async event => {
                    event.stopPropagation();
                    event.preventDefault();
                    await execute();
                    this.update();
                }));
                header.appendChild(toolbarItem);
            }
        }
        return {
            header,
            disposable
        };
    }

    protected onAfterAttach(msg: Message): void {
        if (!this.wrapped.isAttached) {
            Widget.attach(this.wrapped, this.body);
        }
        super.onAfterAttach(msg);
    }

    protected onBeforeDetach(msg: Message): void {
        super.onBeforeDetach(msg);
        if (this.wrapped.isAttached) {
            Widget.detach(this.wrapped);
        }
    }

    protected onUpdateRequest(msg: Message): void {
        if (this.wrapped.isAttached) {
            this.wrapped.update();
        }
        super.onUpdateRequest(msg);
    }

}

export namespace ViewContainerPart {

    /**
     * Make sure to adjust the `line-height` of the `.theia-view-container .part > .header` CSS class when modifying this, and vice versa.
     */
    export const HEADER_HEIGHT = 22;

    export interface ToolbarElement {
        /** default true */
        readonly enabled?: boolean
        readonly className: string | string[]
        readonly tooltip: string
        // tslint:disable-next-line:no-any
        execute(): any
    }

    export interface ContainedWidget extends Widget {
        readonly toolbarElements: ToolbarElement[];
    }

    export namespace ContainedWidget {
        export function is(widget: Widget | undefined): widget is ViewContainerPart.ContainedWidget {
            return !!widget && ('toolbarElements' in widget);
        }
    }

    export interface State {
        partId: string;
        collapsed: boolean;
        hidden: boolean;
        relativeSize?: number;
    }

    export function closestPart(element: Element | EventTarget | null, selector: string = 'div.part'): Element | undefined {
        if (element instanceof Element) {
            const part = element.closest(selector);
            if (part instanceof Element) {
                return part;
            }
        }
        return undefined;
    }
}

export class ViewContainerLayout extends SplitLayout {

    constructor(protected options: ViewContainerLayout.Options, protected readonly splitPositionHandler: SplitPositionHandler) {
        super(options);
    }

    protected get items(): ReadonlyArray<LayoutItem & ViewContainerLayout.Item> {
        // tslint:disable-next-line:no-any
        return (this as any)._items as Array<LayoutItem & ViewContainerLayout.Item>;
    }

    iter(): IIterator<ViewContainerPart> {
        return map(this.items, item => item.widget);
    }

    get widgets(): ViewContainerPart[] {
        return toArray(this.iter());
    }

    moveWidget(fromIndex: number, toIndex: number): void {
        // Note: internally, the `widget` argument is not used. See: `node_modules/@phosphor/widgets/lib/splitlayout.js`.
        // tslint:disable-next-line:no-any
        super.moveWidget(fromIndex, toIndex, undefined as any);
    }

    getPartSize(part: ViewContainerPart): number | undefined {
        if (part.collapsed || part.isHidden) {
            return part.uncollapsedSize;
        }
        if (this.orientation === 'horizontal') {
            return part.node.offsetWidth;
        } else {
            return part.node.offsetHeight;
        }
    }

    /**
     * Set the sizes of the view container parts according to the given weights
     * by moving the split handles. This is similar to `setRelativeSizes` defined
     * in `SplitLayout`, but here we properly consider the collapsed / expanded state.
     */
    setPartSizes(weights: (number | undefined)[]): void {
        const parts = this.widgets;
        const availableSize = this.getAvailableSize();

        // Sum up the weights of visible parts
        let totalWeight = 0;
        let weightCount = 0;
        for (let index = 0; index < weights.length && index < parts.length; index++) {
            const part = parts[index];
            const weight = weights[index];
            if (weight && !part.isHidden && !part.collapsed) {
                totalWeight += weight;
                weightCount++;
            }
        }
        if (weightCount === 0 || availableSize === 0) {
            return;
        }

        // Add the average weight for visible parts without weight
        const averageWeight = totalWeight / weightCount;
        for (let index = 0; index < weights.length && index < parts.length; index++) {
            const part = parts[index];
            const weight = weights[index];
            if (!weight && !part.isHidden && !part.collapsed) {
                totalWeight += averageWeight;
            }
        }

        // Apply the weights to compute actual sizes
        let position = 0;
        for (let index = 0; index < weights.length && index < parts.length - 1; index++) {
            const part = parts[index];
            if (!part.isHidden) {
                if (this.orientation === 'vertical') {
                    position += this.options.headerSize;
                }
                const weight = weights[index];
                if (part.collapsed) {
                    if (weight) {
                        part.uncollapsedSize = weight / totalWeight * availableSize;
                    }
                } else {
                    let contentSize = (weight || averageWeight) / totalWeight * availableSize;
                    const minSize = part.minSize;
                    if (contentSize < minSize) {
                        contentSize = minSize;
                    }
                    position += contentSize;
                }
                this.setHandlePosition(index, position);
                position += this.spacing;
            }
        }
    }

    /**
     * Determine the size of the split panel area that is available for widget content,
     * i.e. excluding part headers and split handles.
     */
    getAvailableSize(): number {
        if (!this.parent || !this.parent.isAttached) {
            return 0;
        }
        const parts = this.widgets;
        const visiblePartCount = parts.filter(part => !part.isHidden).length;
        let availableSize: number;
        if (this.orientation === 'horizontal') {
            availableSize = this.parent.node.offsetWidth;
        } else {
            availableSize = this.parent.node.offsetHeight;
            availableSize -= visiblePartCount * this.options.headerSize;
        }
        availableSize -= (visiblePartCount - 1) * this.spacing;
        if (availableSize < 0) {
            return 0;
        }
        return availableSize;
    }

    /**
     * Update a view container part that has been collapsed or expanded. The transition
     * to the new state is animated.
     */
    updateCollapsed(part: ViewContainerPart, enableAnimation: boolean): void {
        const index = this.items.findIndex(item => item.widget === part);
        if (index < 0 || !this.parent || part.isHidden) {
            return;
        }

        // Do not store the height of the "stretched item". Otherwise, we mess up the "hint height".
        // Store the height only if there are other expanded items.
        const currentSize = this.orientation === 'horizontal' ? part.node.offsetWidth : part.node.offsetHeight;
        if (part.collapsed && this.items.some(item => !item.widget.collapsed && !item.widget.isHidden)) {
            part.uncollapsedSize = currentSize;
        }

        if (!enableAnimation || this.options.animationDuration <= 0) {
            MessageLoop.postMessage(this.parent!, Widget.Msg.FitRequest);
            return;
        }
        let startTime: number | undefined = undefined;
        const duration = this.options.animationDuration;
        const direction = part.collapsed ? 'collapse' : 'expand';
        let fullSize: number;
        if (direction === 'collapse') {
            fullSize = currentSize - this.options.headerSize;
        } else {
            fullSize = Math.max((part.uncollapsedSize || 0) - this.options.headerSize, part.minSize);
            if (this.items.filter(item => !item.widget.collapsed && !item.widget.isHidden).length === 1) {
                // Expand to full available size
                fullSize = Math.max(fullSize, this.getAvailableSize());
            }
        }

        // The update function is called on every animation frame until the predefined duration has elapsed.
        const updateFunc = (time: number) => {
            if (startTime === undefined) {
                startTime = time;
            }
            if (time - startTime < duration) {
                // Render an intermediate state for the animation
                const t = this.tween((time - startTime) / duration);
                if (direction === 'collapse') {
                    part.animatedSize = (1 - t) * fullSize;
                } else {
                    part.animatedSize = t * fullSize;
                }
                requestAnimationFrame(updateFunc);
            } else {
                // The animation is finished
                if (direction === 'collapse') {
                    part.animatedSize = undefined;
                } else {
                    part.animatedSize = fullSize;
                    // Request another frame to reset the part to variable size
                    requestAnimationFrame(() => {
                        part.animatedSize = undefined;
                        MessageLoop.sendMessage(this.parent!, Widget.Msg.FitRequest);
                    });
                }
            }
            MessageLoop.sendMessage(this.parent!, Widget.Msg.FitRequest);
        };
        requestAnimationFrame(updateFunc);
    }

    protected onFitRequest(msg: Message): void {
        for (const part of this.widgets) {
            const style = part.node.style;
            if (part.animatedSize !== undefined) {
                // The part size has been fixed for animating the transition to collapsed / expanded state
                const fixedSize = `${this.options.headerSize + part.animatedSize}px`;
                style.minHeight = fixedSize;
                style.maxHeight = fixedSize;
            } else if (part.collapsed) {
                // The part size is fixed to the header size
                const fixedSize = `${this.options.headerSize}px`;
                style.minHeight = fixedSize;
                style.maxHeight = fixedSize;
            } else {
                const minSize = `${this.options.headerSize + part.minSize}px`;
                style.minHeight = minSize;
                // tslint:disable-next-line:no-null-keyword
                style.maxHeight = null;
            }
        }
        super.onFitRequest(msg);
    }

    /**
     * Sinusoidal tween function for smooth animation.
     */
    protected tween(t: number): number {
        return 0.5 * (1 - Math.cos(Math.PI * t));
    }

    setHandlePosition(index: number, position: number): Promise<void> {
        const options: SplitPositionOptions = {
            referenceWidget: this.widgets[index],
            duration: 0
        };
        // tslint:disable-next-line:no-any
        return this.splitPositionHandler.setSplitHandlePosition(this.parent as SplitPanel, index, position, options) as Promise<any>;
    }

}

export namespace ViewContainerLayout {

    export interface Options extends SplitLayout.IOptions {
        headerSize: number;
        animationDuration: number;
    }

    export interface Item {
        readonly widget: ViewContainerPart;
    }

}
