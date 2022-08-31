import OCR from './ocr.mjs'

const tf = (globalThis.window && window.tf) || (await import('@tensorflow/tfjs-node'));
const createCanvas = await (async function() {
  const browser = globalThis.document && (function(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  });
  if (browser) {
    return browser;
  }

  const Canvas = (await import('skia-canvas')).Canvas;
  return function(width, height) {
    return new Canvas(width, height);
  };
})();

class UnableToParseQuantity extends Error {}

let models = {};
export async function process(screenshotCanvas, modelURL, classNames, options) {
  if (options && options.ocrConcurrency){
    OCR.concurrency = options.ocrConcurrency;
  }
  models[modelURL] ||= tf.loadGraphModel(modelURL);

  const stockpile = extractStockpile(screenshotCanvas);
  if (!stockpile) {
    return undefined;
  }

  stockpile.box.canvas = cropCanvas(screenshotCanvas, stockpile.box);
  stockpile.contents = await extractContents(stockpile.box.canvas, models[modelURL], classNames);

  if (stockpile.contents && stockpile.contents.length) {
    const existingTop = stockpile.box.y;
    stockpile.box.y = Math.max(existingTop - stockpile.contents[0].quantityBox.height, 0);

    const topOffset = existingTop - stockpile.box.y
    stockpile.box.height += topOffset;
    
    for (const element of stockpile.contents) {
      element.iconBox.y += topOffset;
      element.quantityBox.y += topOffset;
    }

    stockpile.box.canvas = cropCanvas(screenshotCanvas, stockpile.box);
  }

  return stockpile;
}

const Screenshot = {
  process,
};
export default Screenshot;

function extractStockpile(canvas) {
  const MIN_INVENTORY_WIDTH = 100;
  const MIN_INVENTORY_HEIGHT = 25;

  const MAX_DARK_CHANNEL_SATURATION = 16;
  const MAX_DARK_PIXEL_LIGHTNESS = 32;

  const MAX_MERGE_VARIANCE = 3;

  const width = canvas.width;
  const height = canvas.height;

  const context = canvas.getContext('2d');
  const pixels = context.getImageData(0, 0, width, height).data;
  let darkStripes = {};

  for (let row = 0; row < height; ++row) {
    let darkCount = 0;
    for (let col = 0; col < width; ++col) {
      const redIndex = calcRedIndex(row, col, width);
      if (isDark(pixels, redIndex)) {
        ++darkCount;
      } else if (darkCount >= MIN_INVENTORY_WIDTH) {
        let left = col - darkCount;
        darkStripes[left] = darkStripes[left] || [];
        darkStripes[left].push({
          row: row,
          right: col - 1,
          left: left,
        });

        darkCount = 0;
      } else {
        darkCount = 0;
      }
    }
  }

  let boxes = Object.values(darkStripes).map(function(stripes) {
    let rights = {};
    for (const stripe of stripes) {
      rights[stripe.right] ||= 0
      rights[stripe.right] += 1;
    }
    // parseInt since keys are strings
    let mostRight = parseInt(Object.keys(rights).sort((a, b) => rights[b] - rights[a])[0], 10);

    let top = Number.MAX_SAFE_INTEGER;
    let bottom = 0;
    let darkStripes = 0;
    for (const stripe of stripes) {
      if ((stripe.right > mostRight - MAX_MERGE_VARIANCE) ||
          (stripe.right < mostRight + MAX_MERGE_VARIANCE)) {
        if (stripe.row < top) top = stripe.row;
        if (stripe.row > bottom) bottom = stripe.row;

        ++darkStripes;
      }
    }

    return {
      top: top,
      right: mostRight,
      bottom: bottom,
      left: stripes[0].left,
      darkStripes: darkStripes,
    };
  });

  if (boxes.length) {
    // Merge overlapping boxes
    let primaryOffset = 0;
    while (primaryOffset < boxes.length - 1) {
      let primary = boxes[primaryOffset];
      let innerOffset = primaryOffset + 1;
      while (innerOffset < boxes.length) {
        let inner = boxes[innerOffset];
        if ((primary.top <= inner.top) &&
            (primary.right >= inner.right) &&
            (primary.bottom >= inner.bottom) &&
            (primary.left <= inner.left)) {
          primary.darkStripes += inner.darkStripes;
          boxes.splice(innerOffset, 1);
        } else {
          ++innerOffset;
        }
      }
      ++primaryOffset;
    }
    boxes = boxes.filter(b => b.bottom - b.top >= MIN_INVENTORY_HEIGHT);

    //check left and right sides are mostly dark
    const MIN_DARK_EDGE_PERCENT = 0.8;
    boxes = boxes.filter(function(box) {
      let darkLeft = 0;
      let darkRight = 0;
      for (let row = box.top; row <= box.bottom; ++row) {
        darkLeft += isDark(pixels, calcRedIndex(row, box.left, width)) ? 1 : 0;
        darkRight += isDark(pixels, calcRedIndex(row, box.right, width)) ? 1 : 0;
      }
      const height = box.bottom - box.top + 1;

      return (darkLeft / height >= MIN_DARK_EDGE_PERCENT)
        && (darkRight / height >= MIN_DARK_EDGE_PERCENT);
    });

    // Prefer the box closest to the middle
    const middle = Math.round(width / 2);
    boxes.sort((a, b) => Math.abs(a.left - middle) - Math.abs(b.left - middle));
    const box = boxes[0];

    // Prefer the box with the most dark stripes by volume
    //boxes.sort((a, b) => (b.darkStripes / (b.bottom - b.top)) - (a.darkStripes / (a.bottom - a.top)));
    //const box = boxes[0];

    return {
      box: {
        x: box.left,
        y: box.top,
        width: box.right - box.left + 1,
        height: box.bottom - box.top + 1,
      }
    };
  }
  return undefined;

  function isDark(pixels, offset) {
    return checkPixel(
      pixels[offset], pixels[offset + 1], pixels[offset + 2],
      MAX_DARK_CHANNEL_SATURATION, 0, MAX_DARK_PIXEL_LIGHTNESS);
  }
}

async function extractContents(canvas, model, classNames) {
  // These tune the cropping of inventory items
  const MIN_QUANTITY_WIDTH = 40;
  const MAX_QUANTITY_WIDTH = 90;

  const MIN_QUANTITY_HEIGHT = 30;
  const MAX_QUANTITY_HEIGHT = 70;

  const MAX_GREY_CHANNEL_VARIANCE = 16;
  const MAX_GREY_PIXEL_VARIANCE = 16;

  const width = canvas.width;
  const height = canvas.height;

  const context = canvas.getContext('2d');
  const pixels = context.getImageData(0, 0, width, height).data;

  // Find the most common grey which is probably the quantity background
  const MIN_GREY = 32;
  const MAX_GREY = 224;
  let greys = {};
  for (let offset = 0; offset < pixels.length; offset += 4) {
    //const value = pixels[offset];
    const value = Math.round((0.299 * pixels[offset]) + (0.587 * pixels[offset + 1]) + (0.114 * pixels[offset + 2]));
    if ((value >= MIN_GREY) &&
        (value <= MAX_GREY) &&
        (pixels[offset + 1] == value) &&
        (pixels[offset + 2] == value)) {
      greys[value] = (greys[value] || 0) + 1;
    }
  }
  const QUANTITY_GREY_VALUE = Object.keys(greys).sort((a, b) => greys[b] - greys[a])[0];

  const contents = [];
  const promises = [];

  for (let row = 0; row < height; ++row) {
    let greyCount = 0;
    let quantityBottom = null;
    let quantityBottomVerified = false;

    for (let col = 0; col < width; ++col) {
      // Opportunity: If > N of same pixel counted, skip to next line
      const redIndex = calcRedIndex(row, col, width);
      if (isGrey(pixels[redIndex], pixels[redIndex+1], pixels[redIndex+2])) {
        ++greyCount;
      } else if ((greyCount >= MIN_QUANTITY_WIDTH) && (greyCount <= MAX_QUANTITY_WIDTH)) {
        const quantityBox = {
          x: col - greyCount,
          y: row,
          width: greyCount,
        };
        let quantityGap;

        if (!quantityBottom || !quantityBottomVerified) {
          quantityBottom = findQtyBottom(pixels, quantityBox.y, quantityBox.x, width, height);
          quantityGap = quantityBox.x;
        } else {
          const previous = contents[contents.length - 1].quantityBox;
          quantityGap = quantityBox.x - (previous.x + previous.width);
        }
        quantityBox.height = quantityBottom - quantityBox.y + 1;
        //console.log(quantityBox);

        if ((quantityBox.height >= MIN_QUANTITY_HEIGHT) && (quantityBox.height <= MAX_QUANTITY_HEIGHT)) {
          // Found an item quantity
          quantityBottomVerified = true;

          const element = {
            quantityBox,
          };
          element.quantityBox.canvas = cropCanvas(canvas, quantityBox, 'invert(100%) contrast(400%)', 5);

          promises.push(ocrQuantity(element.quantityBox.canvas).then(q => element.quantity = q).catch(function(e) {
            if (e instanceof UnableToParseQuantity) {
              console.log('Unable to parse quantity:', quantityBox);
            } else {
              throw e;
            }
          }));

          const iconWidth = quantityBox.height;
          const iconGap = Math.ceil((quantityGap - iconWidth) / 2);
          element.iconBox = {
            x: quantityBox.x - iconGap - iconWidth,
            y: quantityBox.y,
            width: iconWidth,
            height: iconWidth,
          };

          element.iconBox.canvas = cropCanvas(canvas, element.iconBox);
          Object.assign(element, await classifyIcon(element.iconBox.canvas, model, classNames));

          contents.push(element);
        }

        greyCount = 0;
      } else {
        greyCount = 0;
      }
    }

    //console.log(contents.length, quantityBottom);
    if (quantityBottom) {
      row = quantityBottom;
    }
  }

  await Promise.all(promises);

  return contents;

  function findQtyBottom(pixels, row, col, width, height) {
    for (var checkRow = row + 1; checkRow <= height; ++checkRow) {
      const redIndex = calcRedIndex(checkRow, col, width);
      if (!isGrey(pixels[redIndex], pixels[redIndex+1], pixels[redIndex+2])) {
        break;
      }
    }
    return checkRow - 1;
  }

  function isGrey(r, g, b) {
    return checkPixel(r, g, b, MAX_GREY_CHANNEL_VARIANCE, QUANTITY_GREY_VALUE, MAX_GREY_PIXEL_VARIANCE);
  }
}

async function ocrQuantity(canvas) {
  const result = await OCR.recognize(canvas);

  let value = result.data.text.trim();
  if (value.match(/^[1-9][0-9]*k\+$/)) {
    value = parseInt(value.slice(0, -2), 10) * 1000;
  } else if (value.match(/^([1-9][0-9]*|[0-9])$/)) {
    value = parseInt(value, 10);
  } else {
    throw new UnableToParseQuantity(value);
  }

  return value;
}

const CRATED_REGEXP = new RegExp('-crated$');
async function classifyIcon(canvas, model, classNames) {
  const tfImage = tf.image.resizeBilinear(tf.browser.fromPixels(canvas), [32, 32])
  const prediction = (await model).predict(tfImage.expandDims(0));

  const best = prediction.argMax(1).dataSync()[0];
  const key = classNames[best];

  return {
    CodeName: key.replace(CRATED_REGEXP, ''),
    isCrated: !!key.match(CRATED_REGEXP),
  };
}

function cropCanvas(input, box, filter, resize) {
  if (!filter) filter = 'none';
  if (!resize) resize = 1;

  const outputWidth = Math.round(box.width * resize);
  const outputHeight = Math.round(box.height * resize);

  const output = createCanvas();
  output.width = outputWidth;
  output.height = outputHeight;

  const outputContext = output.getContext("2d");
  outputContext.filter = filter;
  outputContext.drawImage(input,
      box.x, box.y, box.width, box.height,
      0, 0, outputWidth, outputHeight);

  return output;
}

function calcRedIndex(row, col, width) {
  // Assumes RGBA packing
  return (col * 4) + (row * width * 4);
}

function checkPixel(r, g, b, max_saturation, desired_lightness, lightness_variance) {
  //const lightness = (r + g + b) / 3;
  //const lightness = (0.299 * r) + (0.587 * g) + (0.114 * b);
  /*
  return (Math.abs(lightness - r) < channel_variance) &&
    (Math.abs(lightness - g) < channel_variance) &&
    (Math.abs(lightness - b) < channel_variance) &&
    (Math.abs(lightness - pixel_value) < pixel_variance);
  */
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const saturation = max > 0 ? (max - min) / max : 0;
  return (saturation <= max_saturation) &&
    (Math.abs(lightness - desired_lightness) < lightness_variance);
}
