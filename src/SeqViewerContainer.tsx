import * as React from "react";
import { withResizeDetector } from "react-resize-detector";

import Circular from "./Circular/Circular";
import { EventHandler } from "./EventHandler";
import Linear from "./Linear/Linear";
import SelectionHandler from "./SelectionHandler";
import CentralIndexContext from "./centralIndexContext";
import { Annotation, CutSite, Highlight, NameRange, Range, SeqType } from "./elements";
import { isEqual } from "./isEqual";
import SelectionContext, { Selection, defaultSelection } from "./selectionContext";

/**
 * This is the width in pixels of a character that's 12px
 * This will need to change whenever the css of the plasmid viewer text changes
 * just divide the width of some rectangular text by it's number of characters
 */
export const CHAR_WIDTH = 7.2;

interface SeqViewerContainerProps {
  annotations: Annotation[];
  bpColors: { [key: number | string]: string };
  compSeq: string;
  copyEvent: (event: React.KeyboardEvent<HTMLElement>) => boolean;
  cutSites: CutSite[];
  height: number;
  highlights: Highlight[];
  name: string;
  onSelection: (selection: Selection) => void;
  rotateOnScroll: boolean;
  search: NameRange[];
  selection?: {
    clockwise?: boolean;
    end: number;
    start: number;
  };
  seq: string;
  seqType: SeqType;
  showComplement: boolean;
  showIndex: boolean;
  targetRef: React.LegacyRef<HTMLDivElement>;
  /** testSize is a forced height/width that overwrites anything from sizeMe. For testing */
  testSize?: { height: number; width: number };
  translations: Range[];
  viewer: "linear" | "circular" | "both" | "both_flip";
  width: number;
  zoom: { circular: number; linear: number };
}

export interface SeqViewerContainerState {
  centralIndex: {
    circular: number;
    linear: number;
    setCentralIndex: (type: "LINEAR" | "CIRCULAR", value: number) => void;
  };
  selection: Selection;
}

/**
 * a parent sequence viewer component that holds whatever is common between
 * the linear and circular sequence viewers. The Header is an example
 */
class SeqViewerContainer extends React.Component<SeqViewerContainerProps, SeqViewerContainerState> {
  constructor(props: SeqViewerContainerProps) {
    super(props);

    this.state = {
      centralIndex: {
        circular: 0,
        linear: 0,
        setCentralIndex: this.setCentralIndex,
      },
      selection: this.getSelection(defaultSelection, props.selection),
    };
  }

  /** this is here because the size listener is returning a new "size" prop every time */
  shouldComponentUpdate = (nextProps: SeqViewerContainerProps, nextState: any) =>
    !isEqual(nextProps, this.props) || !isEqual(nextState, this.state);

  /**
   * Update the central index of the linear or circular viewer.
   */
  setCentralIndex = (type: "LINEAR" | "CIRCULAR", value: number) => {
    if (type !== "LINEAR" && type !== "CIRCULAR") {
      throw new Error(`Unknown central index type: ${type}`);
    }

    if (this.state.centralIndex[type.toLowerCase()] === value) {
      return; // nothing changed
    }

    this.setState({ centralIndex: { ...this.state.centralIndex, [type.toLowerCase()]: value } });
  };

  /**
   * Update selection in state. Should only be performed from handlers/selection.jsx
   */
  setSelection = (selection: Selection) => {
    // If the user passed a selection, do not update our state here
    const { parent, ref, ...rest } = selection;
    if (!this.props.selection) this.setState({ selection });
    if (this.props.onSelection) this.props.onSelection(rest);
  };

  /**
   * Returns the selection that was either a prop (optional) or the selection maintained in state.
   */
  getSelection = (
    state: Selection,
    prop?: {
      clockwise?: boolean;
      end: number;
      start: number;
    }
  ): Selection => {
    if (prop) {
      return { ...prop, clockwise: typeof prop.clockwise === "undefined" || !!prop.clockwise, type: "" };
    }
    return state;
  };

  /**
   * given the width of the screen, and the current zoom, how many basepairs should be displayed
   * on the screen at a given time and what should their size be
   */
  linearProps = () => {
    const { seq, seqType, viewer } = this.props;
    const size = this.props.testSize || { height: this.props.height, width: this.props.width };
    const zoom = this.props.zoom.linear;

    // hack
    if (viewer.includes("both")) {
      size.width /= 2;
    }

    const seqFontSize = Math.min(Math.round(zoom * 0.1 + 9.5), 18); // max 18px

    // otherwise the sequence needs to be cut into smaller subsequences
    // a sliding scale in width related to the degree of zoom currently active
    let bpsPerBlock = Math.round((size.width / seqFontSize) * 1.4) || 1; // width / 1 * seqFontSize
    if (seqType === "aa") {
      bpsPerBlock = Math.round(bpsPerBlock / 3); // more space for each amino acid
    }

    if (zoom <= 5) {
      bpsPerBlock *= 3;
    } else if (zoom <= 10) {
      // really ramp up the range, since at this zoom it'll just be a line
      bpsPerBlock *= 2;
    } else if (zoom > 70) {
      // keep font height the same but scale number of bps in one row
      bpsPerBlock = Math.round(bpsPerBlock * (70 / zoom));
    }
    bpsPerBlock = Math.max(1, bpsPerBlock);

    if (size.width && bpsPerBlock < seq.length) {
      size.width -= 28; // -28 px for the padding (10px) + scroll bar (18px)
    }

    const charWidth = size.width / bpsPerBlock; // width of each basepair

    const lineHeight = 1.4 * seqFontSize; // aspect ratio is 1.4 for roboto mono
    const elementHeight = 16; // the height, in pixels, of annotations, ORFs, etc

    return {
      ...this.props,
      bpsPerBlock,
      charWidth,
      elementHeight,
      lineHeight,
      seqFontSize,
      size,
      zoom: { linear: zoom },
    };
  };

  /**
   * given the length of the sequence and the dimensions of the viewbox, how should
   * zoom of the plasmid viewer affect the radius of the circular viewer and its vertical shift
   *
   * minPixelPerBP = s / 50 where
   * s = theta * radius where
   * radius = h / 2 + c ^ 2 / 8 h    (https://en.wikipedia.org/wiki/Circular_segment)
   * and theta = 50 / seqLength
   */
  circularProps = () => {
    const {
      seq: { length: seqLength },
      viewer,
    } = this.props;
    const size = this.props.testSize || { height: this.props.height, width: this.props.width };
    const zoom = this.props.zoom.circular;

    // hack
    if (viewer.includes("both")) {
      size.width /= 2;
    }

    const center = {
      x: size.width / 2,
      y: size.height / 2,
    };

    const limitingDim = Math.min(size.height, size.width);

    const exp = 0.83; // exponent... greater exp leads to flatter curve (c in fig)
    const beta = Math.exp(Math.log(50 / seqLength) / -(100 ** exp)); // beta coefficient (b in fig)
    const bpsOnArc = seqLength * beta; // calc using the full expression

    // scale the radius so only (bpsOnArc) many bps are shown
    const radius = limitingDim * 0.34;

    return {
      ...this.props,
      bpsOnArc,
      center,
      radius: radius === 0 ? 1 : radius,
      size,
      yDiff: 0,
      zoom: { circular: zoom },
    };
  };

  render() {
    const { selection: selectionProp, seq, viewer } = this.props;
    const { centralIndex, selection } = this.state;

    const linearProps = this.linearProps();
    const circularProps = this.circularProps();

    return (
      <div ref={this.props.targetRef} className="la-vz-viewer-container" data-testid="la-vz-viewer-container">
        <CentralIndexContext.Provider value={centralIndex}>
          <SelectionContext.Provider value={this.getSelection(selection, selectionProp)}>
            <SelectionHandler
              bpsPerBlock={linearProps.bpsPerBlock}
              center={circularProps.center}
              centralIndex={centralIndex.circular}
              seq={seq}
              setCentralIndex={this.setCentralIndex}
              setSelection={this.setSelection}
              yDiff={circularProps.yDiff}
            >
              {(inputRef, handleMouseEvent, onUnmount) => (
                <EventHandler
                  bpsPerBlock={linearProps.bpsPerBlock}
                  copyEvent={this.props.copyEvent}
                  handleMouseEvent={handleMouseEvent}
                  selection={selection}
                  seq={seq}
                  setSelection={this.setSelection}
                >
                  {/* TODO: this sucks, some breaking refactor in future should get rid of it SeqViewer */}
                  {viewer === "linear" && (
                    <Linear
                      {...linearProps}
                      handleMouseEvent={handleMouseEvent}
                      inputRef={inputRef}
                      onUnmount={onUnmount}
                    />
                  )}
                  {viewer === "circular" && (
                    <Circular
                      {...circularProps}
                      handleMouseEvent={handleMouseEvent}
                      inputRef={inputRef}
                      onUnmount={onUnmount}
                    />
                  )}
                  {viewer === "both" && (
                    <>
                      <Circular
                        {...circularProps}
                        handleMouseEvent={handleMouseEvent}
                        inputRef={inputRef}
                        onUnmount={onUnmount}
                      />
                      <Linear
                        {...linearProps}
                        handleMouseEvent={handleMouseEvent}
                        inputRef={inputRef}
                        onUnmount={onUnmount}
                      />
                    </>
                  )}
                  {viewer === "both_flip" && (
                    <>
                      <Linear
                        {...linearProps}
                        handleMouseEvent={handleMouseEvent}
                        inputRef={inputRef}
                        onUnmount={onUnmount}
                      />
                      <Circular
                        {...circularProps}
                        handleMouseEvent={handleMouseEvent}
                        inputRef={inputRef}
                        onUnmount={onUnmount}
                      />
                    </>
                  )}
                </EventHandler>
              )}
            </SelectionHandler>
          </SelectionContext.Provider>
        </CentralIndexContext.Provider>
      </div>
    );
  }
}

export default withResizeDetector(SeqViewerContainer);
