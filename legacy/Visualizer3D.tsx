
import React, { useMemo, useRef, useEffect, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, OrthographicCamera, Grid, Text, Html } from '@react-three/drei';
import * as THREE from 'three';
import { Dataset, ViewStyle, CameraMode, LightingMode, ColormapType } from '../types';
import { getLogNits } from '../utils/dataUtils';
import { getGlslColorFunction, getJsColor } from '../utils/colormapUtils';

// Fix for missing JSX types
declare global {
  namespace JSX {
    interface IntrinsicElements {
      mesh: any;
      primitive: any;
      instancedMesh: any;
      boxGeometry: any;
      meshStandardMaterial: any;
      ambientLight: any;
      directionalLight: any;
      group: any;
    }
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      mesh: any;
      primitive: any;
      instancedMesh: any;
      boxGeometry: any;
      meshStandardMaterial: any;
      ambientLight: any;
      directionalLight: any;
      group: any;
    }
  }
}

// --- Helper Component: Gray 255 Line for Animation ---
const Gray255Line: React.FC<{ dataset: Dataset, visible: boolean }> = ({ dataset, visible }) => {
    const lineGeometry = useMemo(() => {
        const points = [];
        const SCALE_X = 5;
        const SCALE_Y = 1.5;
        const SCALE_Z = 0.05;

        // Find the row closest to 255
        let bestR = -1;
        let minDiff = Infinity;
        for (let r = 0; r < dataset.matrix.rows.length; r++) {
            const diff = Math.abs(dataset.matrix.rows[r] - 255);
            if (diff < minDiff) {
                minDiff = diff;
                bestR = r;
            }
        }

        if (bestR !== -1) {
            const row = dataset.matrix.grid[bestR];
            const cols = dataset.matrix.cols.length;
            const maxNits = Math.max(...dataset.matrix.headerNits);
            const TOTAL_WIDTH = getLogNits(maxNits) * 5;
            const step = TOTAL_WIDTH / Math.max(cols, 1);
            const z = -dataset.matrix.rows[bestR] * SCALE_Z;

            for (let c = 0; c < row.length; c++) {
                const p = row[c];
                if (!p) continue;
                
                // Flip X: (cols - 1 - c)
                const x = (cols - 1 - c) * step;
                const y = p.svm * SCALE_Y;
                points.push(new THREE.Vector3(x, y, z));
            }
        }
        return new THREE.BufferGeometry().setFromPoints(points);
    }, [dataset]);

    return (
        <line geometry={lineGeometry} visible={visible}>
            <lineBasicMaterial attach="material" color="yellow" linewidth={3} />
        </line>
    );
};

const SurfaceMesh: React.FC<{ 
    dataset: Dataset, 
    lighting: LightingMode, 
    clipLowGray: boolean,
    viewStyle: ViewStyle,
    colormap: ColormapType,
    onHover: (data: any) => void,
    opacity?: number
}> = ({ dataset, lighting, clipLowGray, viewStyle, colormap, onHover, opacity = 1.0 }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  
  const { geometry, attributes } = useMemo(() => {
    const rows = dataset.matrix.rows.length;
    const cols = dataset.matrix.cols.length;
    
    const vertices = [];
    const indices = [];
    const nitsAttr = [];
    const svmAttr = [];
    
    const SCALE_X = 5; 
    const SCALE_Z = 0.05; 
    const SCALE_Y = 1.5; 

    const isFlatMode = viewStyle === ViewStyle.FLAT;

    // Generate Vertices
    // If Flat Mode: Only 1 Pass (Top), Y fixed to 0.
    // If Smooth Mode: 2 Passes (Top, Bottom) for solid mesh.
    const passes = isFlatMode ? 1 : 2;

    for (let pass = 0; pass < passes; pass++) {
        const isBottom = pass === 1;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const point = dataset.matrix.grid[r][c];
                
                // Z axis: Gray level
                const z = dataset.matrix.rows[r] * SCALE_Z; 
                
                let nits = 0;
                let svm = 0;
                
                if (point) {
                    nits = point.nits;
                    svm = point.svm;
                }

                // X position based on Column Header Nits (Structured Grid)
                const headerNits = dataset.matrix.headerNits[c] || 0;
                const x = getLogNits(headerNits) * SCALE_X;
                
                // Y position: 
                // Flat Mode: Always 0
                // Smooth Mode Top: SVM height
                // Smooth Mode Bottom: 0
                let y = 0;
                if (!isFlatMode && !isBottom) {
                    y = svm * SCALE_Y;
                }

                vertices.push(x, y, -z); 
                
                nitsAttr.push(nits); 
                svmAttr.push(svm);
            }
        }
    }

    const stride = rows * cols;

    // Helper to add quad
    const addQuad = (a: number, b: number, c: number, d: number) => {
        indices.push(a, b, d);
        indices.push(b, c, d);
    };

    // Helper to check if a quad should be skipped (Clipping Logic)
    const shouldSkip = (r: number, c: number) => {
        // 1. Clip Low Gray (if enabled)
        if (clipLowGray) {
            if (dataset.matrix.rows[r] < 15 || dataset.matrix.rows[r+1] < 15) return true;
        }

        // 2. Clip High Nits (> 500)
        const nitsLeft = dataset.matrix.headerNits[c];
        const nitsRight = dataset.matrix.headerNits[c+1];
        if (nitsLeft > 500 || nitsRight > 500) return true;

        return false;
    };

    // Generate Faces
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        if (shouldSkip(r, c)) continue;

        const curr = r * cols + c;
        const right = r * cols + (c + 1);
        const down = (r + 1) * cols + c;
        const downRight = (r + 1) * cols + (c + 1);

        // 1. Top Surface (CCW)
        addQuad(curr, down, downRight, right);

        // 2. Bottom Surface (CW) - Only if not flat mode
        if (!isFlatMode) {
            const bCurr = curr + stride;
            const bRight = right + stride;
            const bDown = down + stride;
            const bDownRight = downRight + stride;
            addQuad(bCurr, bRight, bDownRight, bDown);
        }
      }
    }

    // 3. Side Walls - Only if not flat mode
    if (!isFlatMode) {
        // Top Row (Back)
        if (!clipLowGray || dataset.matrix.rows[0] >= 15) {
            for(let c=0; c<cols-1; c++) {
                if (dataset.matrix.headerNits[c] > 500 || dataset.matrix.headerNits[c+1] > 500) continue;
                
                const curr = 0 * cols + c;
                const next = 0 * cols + (c+1);
                const bCurr = curr + stride;
                const bNext = next + stride;
                addQuad(curr, next, bNext, bCurr);
            }
        }

        // Bottom Row (Front)
        let lastRowIdx = rows - 1;
        if (clipLowGray) {
            for (let r = rows - 1; r >= 0; r--) {
                if (dataset.matrix.rows[r] >= 15) {
                    lastRowIdx = r;
                    break;
                }
            }
        }
        
        if (!clipLowGray || dataset.matrix.rows[lastRowIdx] >= 15) {
            for(let c=0; c<cols-1; c++) {
                if (dataset.matrix.headerNits[c] > 500 || dataset.matrix.headerNits[c+1] > 500) continue;

                const curr = lastRowIdx * cols + c;
                const next = lastRowIdx * cols + (c+1);
                const bCurr = curr + stride;
                const bNext = next + stride;
                addQuad(curr, bCurr, bNext, next);
            }
        }

        // Left Col
        for(let r=0; r<rows-1; r++) {
            if (shouldSkip(r, 0)) continue;
            const curr = r * cols + 0;
            const down = (r+1) * cols + 0;
            const bCurr = curr + stride;
            const bDown = down + stride;
            addQuad(curr, bCurr, bDown, down);
        }

        // Right Col
        let lastColIdx = cols - 1;
        for (let c = cols - 1; c >= 0; c--) {
            if (dataset.matrix.headerNits[c] <= 500) {
                lastColIdx = c;
                break;
            }
        }

        if (lastColIdx >= 0) {
            for(let r=0; r<rows-1; r++) {
                if (clipLowGray && (dataset.matrix.rows[r] < 15 || dataset.matrix.rows[r+1] < 15)) continue;
                if (dataset.matrix.headerNits[lastColIdx] > 500) continue; 

                const curr = r * cols + lastColIdx;
                const down = (r+1) * cols + lastColIdx;
                const bCurr = curr + stride;
                const bDown = down + stride;
                addQuad(curr, down, bDown, bCurr);
            }
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geo.setAttribute('nits', new THREE.Float32BufferAttribute(nitsAttr, 1));
    geo.setAttribute('svm', new THREE.Float32BufferAttribute(svmAttr, 1));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    return { geometry: geo, attributes: { nits: nitsAttr, svm: svmAttr } };
  }, [dataset, clipLowGray, viewStyle]);

  const shaderMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uMinSvm: { value: 0.0 },
        uMaxSvm: { value: 6.0 }, 
        uShowContours: { value: 0.0 },
        uOpacity: { value: 1.0 }
      },
      vertexShader: `
        varying float vSvm;
        varying float vNits;
        varying vec3 vViewPosition;
        varying vec3 vNormal;
        
        attribute float nits;
        attribute float svm;

        void main() {
          vSvm = svm;
          vNits = nits;
          vNormal = normalize(normalMatrix * normal);
          
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = -mvPosition.xyz;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying float vSvm;
        varying float vNits;
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        
        uniform float uShowContours;
        uniform float uOpacity;

        ${getGlslColorFunction(colormap)}

        void main() {
          vec3 finalColor = getHeatmapColor(vSvm);

          // Contour Lines: Thicker, Solid, White
          float f = fwidth(vSvm);
          float line = 0.0;
          
          // Use step for sharp lines
          if (f > 0.0001) {
              float w = 2.5 * f; // Thicker lines (was 1.0)
              if (abs(vSvm - 0.4) < w) line = 1.0;
              if (abs(vSvm - 1.0) < w) line = 1.0;
              if (abs(vSvm - 3.0) < w) line = 1.0;
          }
          
          vec3 contourColor = vec3(1.0, 1.0, 1.0); // White
          
          if (uShowContours > 0.5 && line > 0.5) {
              finalColor = contourColor;
          }
          
          // Lighting:
          // For Flat Mode (Heatmap), we want pure colors (Unlit).
          // For 3D mode, we want strong 3D effect (High Contrast).
          
          vec3 lightDir = normalize(vec3(0.5, 1.0, 0.5));
          float diff = max(dot(vNormal, lightDir), 0.0);
          
          // 60% Ambient + 40% Diffuse -> Stronger 3D effect
          vec3 litColor = finalColor * (0.6 + 0.4 * diff); 

          gl_FragColor = vec4(litColor, uOpacity);
          
          #include <colorspace_fragment>
        }
      `,
      side: THREE.DoubleSide,
      transparent: true,
    });
  }, [colormap]);

  useEffect(() => {
      shaderMaterial.uniforms.uShowContours.value = viewStyle === ViewStyle.FLAT ? 1.0 : 0.0;
      shaderMaterial.uniforms.uOpacity.value = opacity;
  }, [viewStyle, opacity, shaderMaterial]);

  return (
    <mesh 
        ref={meshRef} 
        geometry={geometry}
        onPointerMove={(e) => {
            e.stopPropagation();
            const { x, y, z } = e.point;
            
            const SCALE_Z = 0.05;
            const SCALE_X = 5;
            
            // Find Row (Gray)
            const targetGray = -z / SCALE_Z;
            let bestR = -1;
            let minDiffR = Infinity;
            
            for(let i=0; i<dataset.matrix.rows.length; i++) {
                const diff = Math.abs(dataset.matrix.rows[i] - targetGray);
                if(diff < minDiffR) {
                    minDiffR = diff;
                    bestR = i;
                }
            }
            
            // Find Col (Nits)
            const targetLogNits = x / SCALE_X;
            let bestC = -1;
            let minDiffC = Infinity;
            
            for(let i=0; i<dataset.matrix.headerNits.length; i++) {
                const hn = dataset.matrix.headerNits[i];
                const ln = getLogNits(hn);
                const diff = Math.abs(ln - targetLogNits);
                if(diff < minDiffC) {
                    minDiffC = diff;
                    bestC = i;
                }
            }
            
            if (bestR !== -1 && bestC !== -1) {
                const p = dataset.matrix.grid[bestR][bestC];
                if (p) {
                    onHover({
                        x, y, z,
                        nits: p.nits,
                        svm: p.svm,
                        gray: p.gray
                    });
                    return;
                }
            }
            onHover(null);
        }}
        onPointerOut={() => onHover(null)}
    >
        <primitive object={shaderMaterial} attach="material" />
    </mesh>
  );
};

const BarsMesh: React.FC<{ 
    dataset: Dataset, 
    clipLowGray: boolean, 
    colormap: ColormapType, 
    onHover: (data: any) => void,
    animationState?: { phase: number, progress: number },
    opacity?: number
}> = ({ dataset, clipLowGray, colormap, onHover, animationState, opacity = 1.0 }) => {
   const meshRef = useRef<THREE.InstancedMesh>(null);
   const dummy = useMemo(() => new THREE.Object3D(), []);

   const { points, grayLevels } = useMemo(() => {
      const validPoints: {x:number, y:number, z:number, svm:number, nits:number, width:number, gray:number}[] = [];
      const SCALE_Z = 0.05; 
      const SCALE_Y = 1.5; 
      const grays = new Set<number>();
      
      const rows = dataset.matrix.rows.length;
      const cols = dataset.matrix.cols.length;
      // const headerNits = dataset.matrix.headerNits;

      // Uniform Spacing Trick
      // Match SurfaceMesh width: maxLog * SCALE_X
      const maxNits = Math.max(...dataset.matrix.headerNits);
      const TOTAL_WIDTH = getLogNits(maxNits) * 5;
      const step = TOTAL_WIDTH / Math.max(cols, 1);
      const width = step * 0.9; // 90% fill, 10% gap

      for (let r = 0; r < rows; r++) {
          if (clipLowGray && dataset.matrix.rows[r] < 15) continue;
          grays.add(dataset.matrix.rows[r]);

          for (let c = 0; c < cols; c++) {
              const p = dataset.matrix.grid[r][c];
              if (!p) continue;

              let displaySvm = p.svm;

              // Check if we need to interpolate (filling the gap for > 500 nits)
              if (p.nits > 500) {
                   // Search Left
                   let leftIdx = -1;
                   for (let k = c - 1; k >= 0; k--) {
                       const neighbor = dataset.matrix.grid[r][k];
                       if (neighbor && neighbor.nits <= 500) {
                           leftIdx = k;
                           break;
                       }
                   }

                   // Search Right
                   let rightIdx = -1;
                   for (let k = c + 1; k < cols; k++) {
                       const neighbor = dataset.matrix.grid[r][k];
                       if (neighbor && neighbor.nits <= 500) {
                           rightIdx = k;
                           break;
                       }
                   }

                   if (leftIdx !== -1 && rightIdx !== -1) {
                       // Linear Interpolation
                       const valL = dataset.matrix.grid[r][leftIdx].svm;
                       const valR = dataset.matrix.grid[r][rightIdx].svm;
                       const ratio = (c - leftIdx) / (rightIdx - leftIdx);
                       displaySvm = valL + (valR - valL) * ratio;
                   } else if (leftIdx !== -1) {
                       // Clamp Left
                       displaySvm = dataset.matrix.grid[r][leftIdx].svm;
                   } else if (rightIdx !== -1) {
                       // Clamp Right
                       displaySvm = dataset.matrix.grid[r][rightIdx].svm;
                   } else {
                       // No neighbors found (entire row > 500?), skip
                       continue;
                   }
              }

              // Use Ordinal X Position instead of Metric Log Nits
              // Flip X: (cols - 1 - c) to make Low Nits on Left (assuming dataset cols are High->Low)
              const x = (cols - 1 - c) * step;
              
              // Position is centered at Y = height/2 (for full height)
              // We'll adjust dynamically in useFrame, but here is the target
              const y = (displaySvm * SCALE_Y) / 2; 
              const z = -p.gray * SCALE_Z;
              
              validPoints.push({ x, y, z, svm: displaySvm, nits: p.nits, width, gray: p.gray });
          }
      }
      
      // Sort Gray Levels descending (255 -> 0) for grouped growth
      const sortedGrays = Array.from(grays).sort((a, b) => b - a);
      
      return { points: validPoints, grayLevels: sortedGrays };
   }, [dataset, clipLowGray]);

   useFrame(() => {
      if (!meshRef.current) return;
      const SCALE_Y = 1.5;
      
      const phase = animationState?.phase || 0;
      const progress = animationState?.progress || 0;

      points.forEach((p, i) => {
         let scaleY = p.svm * SCALE_Y;
         
         if (phase > 0 && phase <= 7) { // Update for phases up to 7
             const is255 = Math.abs(p.gray - 255) < 5;
             
             if (phase === 1) {
                 // Phase 1: Grow 255
                 if (is255) {
                     scaleY = p.svm * SCALE_Y * progress;
                 } else {
                     scaleY = 0;
                 }
             } else if (phase === 2) {
                 // Phase 2: 255 Full, others hidden
                 if (is255) {
                     scaleY = p.svm * SCALE_Y;
                 } else {
                     scaleY = 0;
                 }
             } else if (phase === 3 || phase === 4) {
                 // Phase 3: Camera Move (wait)
                 // Phase 4: Grow Others (Grouped)
                 if (is255) {
                     scaleY = p.svm * SCALE_Y;
                 } else {
                     if (phase === 3) {
                         scaleY = 0;
                     } else {
                         // Phase 4: Grouped Growth
                         // Gray Levels are sorted 255 -> 0.
                         // 255 is index 0. But we skip it? Or include it?
                         // 255 is already grown.
                         // Let's check index in grayLevels
                         const gIdx = grayLevels.indexOf(p.gray);
                         // If gIdx is 0 (255), it's done.
                         
                         const totalGroups = grayLevels.length;
                         // We want to grow from index 1 to end.
                         // progress goes 0->1.
                         // effective groups to grow: totalGroups - 1
                         
                         // Let's just map progress to group index.
                         // Normalized time for this group?
                         // Let's say we grow all groups (including 255 re-growing? No).
                         
                         if (gIdx === 0) {
                             scaleY = p.svm * SCALE_Y;
                         } else {
                             // gIdx 1..N
                             // Map progress 0..1 to groups 1..N
                             // start time for group g: (g - 1) / (N - 1)
                             // duration per group: 1 / (N - 1)
                             
                             const effectiveGroups = Math.max(1, totalGroups - 1);
                             const groupProgressStart = (gIdx - 1) / effectiveGroups;
                             const groupProgressEnd = gIdx / effectiveGroups; // Simple equal slices
                             
                             // Local progress for this group
                             // We want to stagger them.
                             // Use a slightly wider window for smoother overlap?
                             // Or strict sequence? User said "Group by group".
                             
                             // Strict sequence:
                             // if progress < start, scale = 0
                             // if progress > end, scale = full
                             // else interpolate
                             
                             // Actually, let's use a smoother approach:
                             // Each group takes a portion of time.
                             
                             const normalizedP = (progress - groupProgressStart) * effectiveGroups;
                             const clampedP = Math.max(0, Math.min(1, normalizedP));
                             
                             scaleY = p.svm * SCALE_Y * clampedP;
                         }
                     }
                 }
             } else if (phase === 5 || phase === 6) {
                 // Phase 5: Flatten Bars (Transition to Table)
                 // Phase 6: Hold Table
                 // Animate scaleY to 0.01 based on progress of phase 5?
                 // No, Phase 5 is the transition.
                 // Phase 6 is holding.
                 
                 if (phase === 5) {
                     // progress 0->1: Flatten
                     const t = 1 - progress; // 1 -> 0
                     // Keep a minimum thickness
                     scaleY = Math.max(0.01, p.svm * SCALE_Y * t);
                 } else {
                     // Phase 6: Flat
                     scaleY = 0.01;
                 }
             } else if (phase === 7) {
                 // Phase 7: Fade Out (Transition to Surface)
                 // Bars are flat (0.01). Opacity will handle visibility.
                 scaleY = 0.01;
             }
         }

         // Update Position and Scale
         dummy.position.set(p.x, scaleY / 2, p.z); 
         dummy.scale.set(p.width, Math.max(0.001, scaleY), 0.8); 
         dummy.updateMatrix();
         meshRef.current!.setMatrixAt(i, dummy.matrix);
      });
      
      meshRef.current.instanceMatrix.needsUpdate = true;
   });

   useEffect(() => {
      if (!meshRef.current) return;
      points.forEach((p, i) => {
         const c = new THREE.Color(); 
         getJsColor(p.svm, colormap, c);
         meshRef.current!.setColorAt(i, c);
      });
      if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
   }, [points, colormap]);

   return (
      <instancedMesh 
        ref={meshRef} 
        args={[undefined, undefined, points.length]}
        onPointerMove={(e) => {
            e.stopPropagation();
            const id = e.instanceId;
            if (id !== undefined && points[id]) {
                const p = points[id];
                onHover({
                    x: p.x, y: p.y * 2, z: p.z,
                    nits: p.nits, svm: p.svm, gray: p.gray
                });
            }
        }}
        onPointerOut={() => onHover(null)}
      >
         <boxGeometry args={[1, 1, 1]} />
         <meshStandardMaterial 
            roughness={0.6} 
            metalness={0.1} 
            transparent={true} 
            opacity={opacity}
         />
      </instancedMesh>
   );
};

// --- Helper Component: Dynamic Contour Labels & Lines ---
const ContourLabels: React.FC<{ dataset: Dataset, opacity?: number }> = ({ dataset, opacity = 1.0 }) => {
    const { labels, lines } = useMemo(() => {
        const thresholds = [
            { val: 0.4, color: '#ffaaaa' },
            { val: 1.0, color: '#ffffaa' },
            { val: 3.0, color: '#aaffaa' }
        ];

        const SCALE_X = 5;
        const SCALE_Z = 0.05;
        const rows = dataset.matrix.rows.length;
        const cols = dataset.matrix.cols.length;

        // Helper to get position
        const getPos = (r: number, c: number) => {
            const nits = dataset.matrix.headerNits[c] || 0;
            const x = getLogNits(nits) * SCALE_X;
            const z = -dataset.matrix.rows[r] * SCALE_Z;
            return new THREE.Vector3(x, 0.05, z);
        };

        // Helper to get value
        const getVal = (r: number, c: number) => {
            const p = dataset.matrix.grid[r][c];
            return p ? p.svm : -1; // Treat null as low value
        };

        const allLines: { val: number, points: THREE.Vector3[], color: string }[] = [];
        const allLabels: { val: number, x: number, z: number }[] = [];

        thresholds.forEach(t => {
            // Marching Squares Segments
            const segments: { start: THREE.Vector3, end: THREE.Vector3 }[] = [];

            for (let r = 0; r < rows - 1; r++) {
                for (let c = 0; c < cols - 1; c++) {
                    // Values at corners
                    const vTL = getVal(r, c);
                    const vTR = getVal(r, c + 1);
                    const vBR = getVal(r + 1, c + 1);
                    const vBL = getVal(r + 1, c);

                    // Check valid cell (all corners must be valid for simple interpolation, 
                    // or at least the ones involved in the edge. 
                    // For simplicity, treat -1 as "below threshold" unless threshold is < -1 which is not case here)
                    
                    const bTL = vTL >= t.val;
                    const bTR = vTR >= t.val;
                    const bBR = vBR >= t.val;
                    const bBL = vBL >= t.val;

                    // Case Index: TL | TR | BR | BL (8 4 2 1) - wait, standard is usually BL BR TR TL
                    // Let's stick to: MSB -> TL, TR, BR, BL <- LSB
                    const caseIdx = (bTL ? 8 : 0) | (bTR ? 4 : 0) | (bBR ? 2 : 0) | (bBL ? 1 : 0);

                    if (caseIdx === 0 || caseIdx === 15) continue;

                    // Edge Interpolation Helpers
                    // Top Edge: r, c -> r, c+1
                    const getTop = () => {
                        const ratio = (t.val - vTL) / (vTR - vTL);
                        return getPos(r, c).lerp(getPos(r, c + 1), ratio);
                    };
                    // Right Edge: r, c+1 -> r+1, c+1
                    const getRight = () => {
                        const ratio = (t.val - vTR) / (vBR - vTR);
                        return getPos(r, c + 1).lerp(getPos(r + 1, c + 1), ratio);
                    };
                    // Bottom Edge: r+1, c+1 -> r+1, c (Order: Right to Left? No, purely geometry between pts)
                    // Let's use standard: r+1, c -> r+1, c+1
                    const getBottom = () => {
                        const ratio = (t.val - vBL) / (vBR - vBL);
                        return getPos(r + 1, c).lerp(getPos(r + 1, c + 1), ratio);
                    };
                    // Left Edge: r, c -> r+1, c
                    const getLeft = () => {
                        const ratio = (t.val - vTL) / (vBL - vTL);
                        return getPos(r, c).lerp(getPos(r + 1, c), ratio);
                    };

                    // Add segments based on case (Directed: High on Left)
                    switch (caseIdx) {
                        case 1: segments.push({ start: getLeft(), end: getBottom() }); break; // BL
                        case 2: segments.push({ start: getBottom(), end: getRight() }); break; // BR
                        case 3: segments.push({ start: getLeft(), end: getRight() }); break; // BL + BR
                        case 4: segments.push({ start: getRight(), end: getTop() }); break; // TR
                        case 5: // Saddle: BL + TR (Ambiguous). Let's split.
                            segments.push({ start: getLeft(), end: getTop() });
                            segments.push({ start: getBottom(), end: getRight() }); // This assumes 'island' of High. 
                            // Wait, if BL and TR are high. Left->Top (High on Left). Bottom->Right (High on Left). Correct.
                            break;
                        case 6: segments.push({ start: getBottom(), end: getTop() }); break; // BR + TR
                        case 7: segments.push({ start: getLeft(), end: getTop() }); break; // BL+BR+TR
                        case 8: segments.push({ start: getTop(), end: getLeft() }); break; // TL
                        case 9: segments.push({ start: getTop(), end: getBottom() }); break; // TL + BL
                        case 10: // Saddle: TL + BR
                            segments.push({ start: getTop(), end: getRight() });
                            segments.push({ start: getBottom(), end: getLeft() });
                            break;
                        case 11: segments.push({ start: getTop(), end: getRight() }); break; // TL+BL+BR
                        case 12: segments.push({ start: getRight(), end: getLeft() }); break; // TL+TR
                        case 13: segments.push({ start: getRight(), end: getBottom() }); break; // TL+TR+BL (Wait, 13 is 1101: TL TR BL) -> Right to Bottom
                        case 14: segments.push({ start: getBottom(), end: getLeft() }); break; // TL+TR+BR -> Bottom to Left
                        // case 0, 15: handled above
                    }
                }
            }

            // Stitch Segments
            // Map: StartPointHash -> Segment
            // Since points are interpolated floats, exact match might be tricky.
            // But they are generated from the same grid math.
            // Key: integer-like grid coordinates + axis? 
            // Or just use very precise fixed string.
            const pKey = (v: THREE.Vector3) => v.x.toFixed(5) + "_" + v.z.toFixed(5);
            
            const nextMap = new Map<string, { end: THREE.Vector3, used: boolean }[]>();
            
            segments.forEach(seg => {
                const key = pKey(seg.start);
                if (!nextMap.has(key)) nextMap.set(key, []);
                nextMap.get(key)!.push({ end: seg.end, used: false });
            });

            // Trace Paths
            const paths: THREE.Vector3[][] = [];
            
            segments.forEach(seg => {
                // We need to find starts of paths. 
                // A segment is a start if no other segment ends at its start (for open paths).
                // For loops, any segment is a start.
                // Simplified: Pick any unused segment, trace until dead end.
                // Actually, we need to modify 'used' status in the map or segments list.
                // Let's just iterate the map? No, map stores connections.
            });

            // Better Stitching:
            // Iterate all segments. If not visited, start path.
            // Keep appending.
            const visited = new Set<number>();
            
            for (let i = 0; i < segments.length; i++) {
                if (visited.has(i)) continue;
                
                const path = [segments[i].start, segments[i].end];
                visited.add(i);
                
                let currentEnd = segments[i].end;
                let foundNext = true;
                
                while (foundNext) {
                    foundNext = false;
                    // Find a segment that starts at currentEnd
                    // Optimized: use a spatial hash or the map we built?
                    // The map has { end, used }. But we need the index to mark visited?
                    // Let's rebuild map to store index.
                }
            }
            
            // Re-do Stitching with Map<StartHash, SegmentIndex>
            const startMap = new Map<string, number[]>();
            segments.forEach((seg, i) => {
                const k = pKey(seg.start);
                if (!startMap.has(k)) startMap.set(k, []);
                startMap.get(k)!.push(i);
            });

            const stitchedPaths: THREE.Vector3[][] = [];
            const visitedIndices = new Set<number>();

            for (let i = 0; i < segments.length; i++) {
                if (visitedIndices.has(i)) continue;

                // Start a new path
                const path = [segments[i].start.clone(), segments[i].end.clone()];
                visitedIndices.add(i);
                
                let currentTip = segments[i].end;
                let active = true;

                // Extend Forward
                while (active) {
                    const key = pKey(currentTip);
                    const candidates = startMap.get(key);
                    
                    let nextIdx = -1;
                    if (candidates) {
                        for (const idx of candidates) {
                            if (!visitedIndices.has(idx)) {
                                nextIdx = idx;
                                break;
                            }
                        }
                    }

                    if (nextIdx !== -1) {
                        visitedIndices.add(nextIdx);
                        const nextSeg = segments[nextIdx];
                        path.push(nextSeg.end.clone());
                        currentTip = nextSeg.end;
                    } else {
                        active = false;
                    }
                }
                
                // Optimization: Check if this path can connect to previous paths? 
                // Unlikely if we iterate all. 
                // But what if we started in the middle of a line?
                // Marching squares segments are directed. 
                // If we start at a random segment, we trace forward. 
                // We might miss the backward part.
                // However, "Backward" part ends at "Start".
                // So if we iterate ALL segments, eventually we pick up the predecessor.
                // But it will form a separate path ending at our Start.
                // We should merge them?
                // Easier: Look for segments ENDING at our start.
                
                stitchedPaths.push(path);
            }

            // Merge paths (A.end == B.start)
            // Repeat until no merges possible
            let merged = true;
            while (merged) {
                merged = false;
                const startLookup = new Map<string, number>(); // Key -> PathIndex
                const endLookup = new Map<string, number>();   // Key -> PathIndex

                stitchedPaths.forEach((p, idx) => {
                    if (p.length === 0) return;
                    startLookup.set(pKey(p[0]), idx);
                    endLookup.set(pKey(p[p.length - 1]), idx);
                });

                // Try to find End -> Start connections
                for (let i = 0; i < stitchedPaths.length; i++) {
                    if (stitchedPaths[i].length === 0) continue;
                    
                    const myStart = pKey(stitchedPaths[i][0]);
                    const myEnd = pKey(stitchedPaths[i][stitchedPaths[i].length - 1]);
                    
                    // Case 1: Someone ends at my start (Prepend them to me)
                    if (endLookup.has(myStart)) {
                        const otherIdx = endLookup.get(myStart)!;
                        if (otherIdx !== i) {
                            // Merge other + me
                            // Remove overlap point? Yes, other.last == me.first
                            const otherPath = stitchedPaths[otherIdx];
                            const combined = [...otherPath, ...stitchedPaths[i].slice(1)];
                            stitchedPaths[i] = combined;
                            stitchedPaths[otherIdx] = []; // Clear other
                            merged = true;
                            break; // Restart loop to rebuild maps safely
                        } else {
                            // Loop closed (I end at my start) - Fine, do nothing
                        }
                    }
                }
                // Clean up empty paths
                if (merged) {
                     for (let k = stitchedPaths.length - 1; k >= 0; k--) {
                         if (stitchedPaths[k].length === 0) stitchedPaths.splice(k, 1);
                     }
                }
            }

            // Add to results
            stitchedPaths.forEach(pts => {
                 if (pts.length < 2) return;
                 allLines.push({ val: t.val, points: pts, color: t.color });
                 
                 // Calculate Label Position (Halfway)
                 let totalLen = 0;
                 const dists: number[] = [];
                 for (let i = 0; i < pts.length - 1; i++) {
                     const d = pts[i].distanceTo(pts[i+1]);
                     dists.push(d);
                     totalLen += d;
                 }

                 // Filter out labels near boundaries or short paths
                 // Fix maxZ calculation: rows are 0..255 or 255..0
                 const maxZVal = Math.max(...dataset.matrix.rows);
                 const maxZ = maxZVal * 0.05; 

                 const maxNits = Math.max(...dataset.matrix.headerNits);
                 const maxX = getLogNits(maxNits) * 5;
                 
                 // Check if path is too close to boundaries
                 // Use smaller margin (0.2) to avoid hiding valid contours
                 const center = pts[Math.floor(pts.length/2)];
                 
                 // User request: Hide labels where Gray < 30
                 // Gray level g corresponds to z = -g * 0.05
                 // g < 30 => -z/0.05 < 30 => -z < 1.5 => z > -1.5
                 const grayThresholdZ = -30 * 0.05; // -1.5

                 const isNearBoundary = 
                    center.z > grayThresholdZ || // Gray < 30 (Too close to X axis)
                    center.z < -(maxZ - 0.2) || // Near Top
                    center.x < 0.2 || 
                    center.x > (maxX - 0.2);

                 if (totalLen > 0.5 && !isNearBoundary) { // Relaxed length check
                    const targetLen = totalLen * 0.5;
                    let currentLen = 0;
                    let labelPos = pts[0].clone();

                    for (let i = 0; i < dists.length; i++) {
                        if (currentLen + dists[i] >= targetLen) {
                            const remain = targetLen - currentLen;
                            const alpha = remain / dists[i];
                            labelPos.copy(pts[i]).lerp(pts[i+1], alpha);
                            break;
                        }
                        currentLen += dists[i];
                    }
                    allLabels.push({ val: t.val, x: labelPos.x, z: labelPos.z });
                 }
            });
        });

        return { labels: allLabels, lines: allLines };
    }, [dataset]);

    if (opacity < 0.01) return null;

    return (
        <>
            {lines.map((l, i) => (
                 <line key={`line-${i}`}>
                     <bufferGeometry attach="geometry" setFromPoints={l.points} />
                     <lineBasicMaterial attach="material" color={l.color} linewidth={2} transparent opacity={opacity} />
                 </line>
            ))}
            {labels.map((l, i) => (
                <group key={`label-${i}`} position={[l.x, 0.1, l.z]}>
                    <Text 
                        position={[0, 0, 0]} 
                        rotation={[-Math.PI/2, 0, 0]}
                        fontSize={0.4} 
                        color="white"
                        anchorX="center"
                        anchorY="middle"
                        outlineWidth={0.04}
                        outlineColor="black"
                        fillOpacity={opacity}
                        outlineOpacity={opacity}
                    >
                        {l.val.toFixed(1)}
                    </Text>
                </group>
            ))}
        </>
    );
};

// --- Helper Component: ColorBar ---
const ColorBar: React.FC<{ colormap: ColormapType }> = ({ colormap }) => {
    const height = 12.75; 
    const width = 0.8;
    const posX = 16.5; 
    const maxVal = 4.0;

    const material = useMemo(() => new THREE.ShaderMaterial({
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            varying vec2 vUv;
            
            ${getGlslColorFunction(colormap)}

            void main() {
                // UV.y=0 is Local -Y (World Top, Z=0) -> High SVM
                // UV.y=1 is Local +Y (World Bottom, Z=-12.75) -> Low SVM
                float svm = (1.0 - vUv.y) * 4.0;
                gl_FragColor = vec4(getHeatmapColor(svm), 1.0);
                #include <colorspace_fragment>
            }
        `,
        side: THREE.DoubleSide
    }), [colormap]);

    return (
        <group position={[posX, 0.05, -height/2]}>
            {/* The Bar */}
            <mesh rotation={[-Math.PI/2, 0, 0]}>
                <planeGeometry args={[width, height]} />
                <primitive object={material} attach="material" />
            </mesh>
            
            {/* Ticks and Labels */}
            {[0, 0.4, 1.0, 3.0, 4.0].map(val => {
                 const pct = val / 4.0; 
                 const zLocal = (pct - 0.5) * height;

                 return (
                    <group key={val} position={[width/2, 0, zLocal]}>
                         <line position={[0, 0, 0]}>
                            <bufferGeometry attach="geometry" attributes-position={new THREE.Float32BufferAttribute([0, 0, 0, 0.3, 0, 0], 3)} />
                            <lineBasicMaterial attach="material" color="white" />
                         </line>
                         <Text 
                            position={[0.4, 0, 0]} 
                            rotation={[-Math.PI/2, 0, 0]}
                            fontSize={0.4} 
                            color="white"
                            anchorX="left"
                            anchorY="middle"
                         >
                            {val.toFixed(1)}
                         </Text>
                    </group>
                 )
            })}
             <Text 
                position={[0, 0, height/2 + 1.0]} 
                rotation={[-Math.PI/2, 0, 0]}
                fontSize={0.4} 
                color="white"
                anchorX="center"
                anchorY="top"
             >
                SVM
             </Text>
        </group>
    );
};

// --- Helper Component: Plot Border ---
const PlotBorder: React.FC<{ width: number }> = ({ width }) => {
    const w = width;
    const h = 12.75;
    // Box from (0,0,0) to (w,0,-12.75)
    
    const points = [
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(w, 0, 0),
        new THREE.Vector3(w, 0, -h),
        new THREE.Vector3(0, 0, -h),
        new THREE.Vector3(0, 0, 0)
    ];
    const geo = new THREE.BufferGeometry().setFromPoints(points);

    return (
        <line position={[0, 0.05, 0]}>
             <primitive object={geo} attach="geometry" />
             <lineBasicMaterial attach="material" color="white" linewidth={1} />
        </line>
    );
};

// --- Helper Component: Professional Flat Axes ---
const FlatAxes: React.FC<{ width: number, showNits?: boolean }> = ({ width, showNits = true }) => {
    const xTicks = [2, 10, 100, 500];
    const flatRotation: [number, number, number] = [-Math.PI / 2, 0, 0];
    const zOffset = -12.75; // Approx for Gray 255
    const SCALE_X = 5;

    return (
        <group>
            {/* X Axis (Bottom) - Nits */}
            {showNits && (
                <>
                    <line position={[0, 0.05, 0]}>
                        <bufferGeometry attach="geometry" attributes-position={new THREE.Float32BufferAttribute([0, 0, 0, width, 0, 0], 3)} />
                        <lineBasicMaterial attach="material" color="white" linewidth={2} />
                    </line>
                    
                    {xTicks.map(nits => {
                        const x = getLogNits(nits) * SCALE_X;
                        return (
                            <group key={nits} position={[x, 0.05, 0]}>
                                 {/* Tick */}
                                 <line position={[0, 0, 0.2]}>
                                    <bufferGeometry attach="geometry" attributes-position={new THREE.Float32BufferAttribute([0, 0, -0.2, 0, 0, 0], 3)} />
                                    <lineBasicMaterial attach="material" color="white" />
                                 </line>
                                 {/* Label */}
                                 <Text 
                                    position={[0, 0, 0.5]} 
                                    rotation={flatRotation}
                                    fontSize={0.4}
                                    color="white"
                                    anchorX="center"
                                    anchorY="top"
                                 >
                                    {nits}
                                 </Text>
                            </group>
                        )
                    })}
                    
                    <Text 
                        position={[7.5, 0.05, 1.5]} 
                        rotation={flatRotation}
                        fontSize={0.5} 
                        color="white"
                        anchorX="center"
                    >
                        Nits (Log)
                    </Text>
                </>
            )}

            {/* Z Axis (Left) - Gray Level */}
            <line position={[0, 0.05, 0]}>
                <bufferGeometry attach="geometry" attributes-position={new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, zOffset], 3)} />
                <lineBasicMaterial attach="material" color="white" linewidth={2} />
            </line>

             {/* Ticks for Gray Level */}
             {[0, 64, 128, 192, 255].map(g => {
                 const z = -g * 0.05;
                 return (
                    <group key={g} position={[0, 0.05, z]}>
                         <line position={[-0.2, 0, 0]}>
                            <bufferGeometry attach="geometry" attributes-position={new THREE.Float32BufferAttribute([0, 0, 0, 0.2, 0, 0], 3)} />
                            <lineBasicMaterial attach="material" color="white" />
                         </line>
                         <Text 
                            position={[-0.4, 0, 0]} 
                            rotation={flatRotation}
                            fontSize={0.4}
                            color="white"
                            anchorX="right"
                            anchorY="middle"
                         >
                            {g}
                         </Text>
                    </group>
                 )
             })}

             <Text 
                position={[-1.5, 0.05, zOffset / 2]} 
                rotation={[-Math.PI / 2, 0, Math.PI / 2]}
                fontSize={0.5} 
                color="white"
                anchorX="center"
                anchorY="bottom"
             >
                Gray Level
             </Text>
        </group>
    );
};

// --- Helper Component: Table Values (Flat Heatmap Labels) ---
const TableValues: React.FC<{ dataset: Dataset, opacity: number }> = ({ dataset, opacity }) => {
    const points = useMemo(() => {
        const pts: {x:number, z:number, val:number}[] = [];
        const rows = dataset.matrix.rows.length;
        const cols = dataset.matrix.cols.length;
        const SCALE_X = 5;
        const SCALE_Z = 0.05;
        
        const maxNits = Math.max(...dataset.matrix.headerNits);
        const TOTAL_WIDTH = getLogNits(maxNits) * 5;
        const step = TOTAL_WIDTH / Math.max(cols, 1);

        // Dynamic stride based on spatial distance to prevent overlap
        // Rows (Z axis): Check physical Z distance. Min spacing ~ 0.35 (text height + gap)
        // Cols (X axis): Uniformly spaced in X, so simple stride works. Min spacing ~ 0.8
        
        const stepC = Math.ceil(cols / 30);
        
        // Collect valid rows based on Z spacing
        // Always try to include the last row (Gray 0, Z=0) if possible
        const validRowIndices: number[] = [];
        let lastZ = -9999;
        const MIN_Z_SPACING = 0.35;

        // Iterate from Top (Index 0, Z negative) to Bottom (Index last, Z=0 usually)
        // dataset.matrix.rows[r] is Gray Level. Z = -gray * 0.05.
        // If rows are 255 -> 0.
        // Z: -12.75 -> 0.
        
        for (let r = 0; r < rows; r++) {
            const z = -dataset.matrix.rows[r] * SCALE_Z;
            
            // Check distance from last added row
            if (Math.abs(z - lastZ) >= MIN_Z_SPACING) {
                validRowIndices.push(r);
                lastZ = z;
            } else {
                // Conflict.
                // Special handling for the very last row (Bottom Edge).
                // If this is the last row, and we want to show it "inside the lower edge",
                // we might force it. But if it overlaps the previous one, we have a problem.
                // The user asked to "display inside the lower edge". 
                // If we are at the last row (Gray ~0), and we skipped it, 
                // we might want to replace the previous one?
                // Let's keep it simple: Greedy spacing from top to bottom.
                // If the last row is too close to the previous one, it won't be shown.
                // But usually Gray 0 is important.
                // Let's try to FORCE the last row (Gray 0) if it's not added.
                if (r === rows - 1) {
                     // Check distance to the LAST ADDED row
                     const prevR = validRowIndices[validRowIndices.length - 1];
                     if (prevR !== undefined) {
                         const prevZ = -dataset.matrix.rows[prevR] * SCALE_Z;
                         if (Math.abs(z - prevZ) < MIN_Z_SPACING) {
                             // Too close. Replace the previous one?
                             // Or just skip.
                             // User said: "selectively display... putting bottom data inside lower edge"
                             // Let's assume they want the bottom-most data.
                             // So we pop the previous one and add this one?
                             validRowIndices.pop();
                             validRowIndices.push(r);
                             lastZ = z;
                         } else {
                             validRowIndices.push(r);
                         }
                     } else {
                         validRowIndices.push(r);
                     }
                }
            }
        }

        for (const r of validRowIndices) {
             for (let c = 0; c < cols; c++) {
                 if (c % stepC !== 0) continue;
                 const p = dataset.matrix.grid[r][c];
                 if (!p) continue;
                 
                 // Flip X: (cols - 1 - c)
                 const x = (cols - 1 - c) * step;
                 const z = -dataset.matrix.rows[r] * SCALE_Z;
                 pts.push({ x, z, val: p.svm });
             }
        }
        return pts;
    }, [dataset]);

    if (opacity < 0.05) return null;

    return (
        <group>
            {points.map((p, i) => (
                <Text 
                    key={i}
                    position={[p.x, 0.4, p.z]} // Slightly above ground
                    rotation={[-Math.PI/2, 0, 0]}
                    fontSize={0.25} 
                    color="white"
                    fillOpacity={opacity}
                    anchorX="center"
                    anchorY="middle"
                >
                    {p.val.toFixed(1)}
                </Text>
            ))}
        </group>
    );
};

const SceneContent: React.FC<{ 
    datasets: Dataset[], 
    activeDatasetId: string | null,
    viewStyle: ViewStyle,
    lighting: LightingMode,
    clipLowGray: boolean,
    colormap: ColormapType,
    isAnimating: boolean,
    onAnimationEnd: () => void
}> = ({ datasets, activeDatasetId, viewStyle, lighting, clipLowGray, colormap, isAnimating, onAnimationEnd }) => {
    
    const activeDataset = datasets.find(d => d.id === activeDatasetId);
    const [hoverData, setHoverData] = useState<any>(null);
    const { controls } = useThree();
    
    // Animation State
    const animationState = useMemo(() => ({ phase: 0, progress: 0 }), []);
    const startTimeRef = useRef<number | null>(null);
    const [showLine, setShowLine] = useState(false);

    // Opacity States for Transitions
    const [barsOpacity, setBarsOpacity] = useState(1.0);
    const [tableOpacity, setTableOpacity] = useState(0.0);
    const [surfaceOpacity, setSurfaceOpacity] = useState(1.0);
    const [contourOpacity, setContourOpacity] = useState(0.0);

    // Axis Visibility State
    const [visibleGrayThreshold, setVisibleGrayThreshold] = useState(0); // Show all (>= 0)
    
    // Camera Helpers
    const { camera } = useThree();
    const MIN_DIST = 2;
    const MAX_DIST = 80;
    
    const setCameraZoom = (zoomPercent: number) => {
        if (!controls || !camera) return;
        
        const targetDist = MAX_DIST - (zoomPercent / 100) * (MAX_DIST - MIN_DIST);
        const direction = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
        
        if (!direction.x && !direction.y && !direction.z) return; // Safety
        
        const newPos = controls.target.clone().add(direction.multiplyScalar(targetDist));
        camera.position.copy(newPos);
        controls.update();
    };

    useFrame((state) => {
        if (!isAnimating) {
            animationState.phase = 0;
            animationState.progress = 0;
            if (startTimeRef.current !== null) startTimeRef.current = null;
            if (showLine) setShowLine(false);
            // Reset Opacities
            if (viewStyle === ViewStyle.BARS) {
                setBarsOpacity(1.0);
                setTableOpacity(0.0);
                setSurfaceOpacity(0.0);
                setContourOpacity(0.0);
            } else if (viewStyle === ViewStyle.FLAT) {
                setBarsOpacity(0.0);
                setTableOpacity(0.0);
                setSurfaceOpacity(1.0);
                setContourOpacity(1.0);
            } else {
                setBarsOpacity(0.0);
                setTableOpacity(0.0);
                setSurfaceOpacity(1.0);
                setContourOpacity(0.0); // Smooth mode typically no contours?
            }
            setVisibleGrayThreshold(0); // Show all
            return;
        }

        if (startTimeRef.current === null) {
            startTimeRef.current = state.clock.elapsedTime;
            
            // Initial State
            setBarsOpacity(1.0);
            setTableOpacity(0.0);
            setSurfaceOpacity(0.0);
            setContourOpacity(0.0);
            setVisibleGrayThreshold(255); // Only 255 initially

            // Reset Camera to Front View (looking at 255 profile)
            if (controls) {
                const c = controls as any;
                c.setPolarAngle(Math.PI / 2); // Horizontal
                c.setAzimuthalAngle(0); // Front
                c.target.set(0, 0, 0); // Ensure target is centered
                c.update();
                
                // Set Initial Zoom for Phase 1
                setCameraZoom(86);
            }
        }

        const elapsed = state.clock.elapsedTime - startTimeRef.current;

        // Enforce Top View Camera after 8.5s
        if (elapsed >= 8.5 && controls) {
            const c = controls as any;
            c.setPolarAngle(1e-5);
            c.setAzimuthalAngle(0);
            c.target.set(0, 0, 0);
            c.update();
        }

        // Timeline:
        // 0.0 - 1.5: Phase 1 (Grow 255)
        // 1.5 - 3.5: Phase 2 (Show Line)
        // 3.5 - 8.5: Phase 3 (Camera Move) & Phase 4 (Grow Others)
        // 8.5 - 9.5: Phase 5 (Flatten Bars & Show Table)
        // 9.5 - 10.0: Phase 6 (Hold Table)
        // 10.0 - 12.0: Phase 7 (Switch to Surface)
        // 12.0 - 12.5: Phase 8 (Show Contours)
        // 12.5+: Done

        if (elapsed < 1.5) {
            animationState.phase = 1;
            animationState.progress = elapsed / 1.5;
            if (showLine) setShowLine(false);
            setVisibleGrayThreshold(255);
            
            // Keep Zoom at 86%
            setCameraZoom(86);
        } 
        else if (elapsed < 3.5) {
            animationState.phase = 2;
            animationState.progress = (elapsed - 1.5) / 2.0;
            // User requested to remove the line on top of the first scene's bar chart.
            if (showLine) setShowLine(false); 
            setVisibleGrayThreshold(255);
            
            // Keep Zoom at 86%
            setCameraZoom(86);
        } 
        else if (elapsed < 8.5) {
            // Camera Move (5s)
            // Grow Others (4s, start at 4.0s)
            if (showLine) setShowLine(false);
            
            const camProgress = (elapsed - 3.5) / 5.0;
            
            // Camera Animation: Front -> Top
            if (controls) {
                const c = controls as any;
                const startPolar = Math.PI / 2;
                const targetPolar = 1e-5; // Use small epsilon to prevent singularity flip
                const startAzimuth = 0;
                const targetAzimuth = 0; 
                
                // Smoothstep
                const t = camProgress * camProgress * (3 - 2 * camProgress);
                
                c.setPolarAngle(startPolar + (targetPolar - startPolar) * t);
                c.setAzimuthalAngle(startAzimuth + (targetAzimuth - startAzimuth) * t);
                c.update();
            }

            // Grow Others starts at 4.0s
            if (elapsed >= 4.0) {
                animationState.phase = 4; // Grouped Growth
                const p = Math.min(1, (elapsed - 4.0) / 4.5); // 4.5s duration (until 8.5)
                animationState.progress = p;
                
                // Update Gray Threshold: 255 -> 0
                setVisibleGrayThreshold(255 * (1 - p));
                
                // Zoom Animation: 86% -> 75% (Non-linear)
                // p goes 0 -> 1
                const zoomT = p * p * (3 - 2 * p); // Smoothstep
                const currentZoom = 86 + (75 - 86) * zoomT;
                setCameraZoom(currentZoom);
            } else {
                animationState.phase = 3; // Just waiting/camera moving
                animationState.progress = 0;
                setVisibleGrayThreshold(255);
                setCameraZoom(86);
            }
        } 
        else if (elapsed < 9.5) {
            // Phase 5: Flatten Bars -> Table
            animationState.phase = 5;
            const p = (elapsed - 8.5) / 1.0; // 1s transition
            animationState.progress = p;
            
            // Fade in Table
            setTableOpacity(p);
            setVisibleGrayThreshold(0); // All visible
            setCameraZoom(75);
        } 
        else if (elapsed < 10.0) {
            // Phase 6: Hold Table (Shortened to 0.5s)
            animationState.phase = 6;
            animationState.progress = 1;
            setTableOpacity(1.0);
            setVisibleGrayThreshold(0);
            setCameraZoom(75);
        } 
        else if (elapsed < 12.0) {
            // Phase 7: Switch to Surface
            animationState.phase = 7;
            const p = (elapsed - 10.0) / 2.0;
            animationState.progress = p;
            
            // Bars/Table Fade Out, Surface Fade In
            setBarsOpacity(1.0 - p);
            setTableOpacity(1.0 - p);
            setSurfaceOpacity(p);
            setVisibleGrayThreshold(0);
            setCameraZoom(75);
        } 
        else if (elapsed < 12.5) {
            // Phase 8: Fade In Contours
            animationState.phase = 8;
            const p = (elapsed - 12.0) / 0.5;
            setContourOpacity(p);
            
            setBarsOpacity(0.0);
            setTableOpacity(0.0);
            setSurfaceOpacity(1.0);
            setVisibleGrayThreshold(0);
            setCameraZoom(75);
        }
        else {
             animationState.phase = 9;
             animationState.progress = 1;
             if (isAnimating) {
                 // Ensure final state
                 setBarsOpacity(0.0);
                 setTableOpacity(0.0);
                 setSurfaceOpacity(1.0);
                 setContourOpacity(1.0);
                 setVisibleGrayThreshold(0);
                 setCameraZoom(75);
                 onAnimationEnd(); 
                 // Do NOT reset startTimeRef.current here. 
                 // Let isAnimating=false trigger the reset in the next frame.
             }
        }
    });

    const xTicks = [2, 10, 100, 500];
    const flatRotation: [number, number, number] = [-Math.PI / 2, 0, 0];
    const zOffset = -12.75; 
    
    // Determine visibility based on animation or viewStyle
    const showBars = isAnimating ? barsOpacity > 0.01 : viewStyle === ViewStyle.BARS;
    const showSurface = isAnimating ? surfaceOpacity > 0.01 : (viewStyle === ViewStyle.SMOOTH || viewStyle === ViewStyle.FLAT);
    const showTable = isAnimating && tableOpacity > 0.01;
    
    // X Axis Visibility: Hide during entire animation process
    const showXAxis = !isAnimating;

    return (
        <>
            {lighting === LightingMode.STUDIO && (
                <>
                    <ambientLight intensity={0.4} />
                    <directionalLight position={[10, 20, 10]} intensity={2.0} />
                    <directionalLight position={[-10, 5, -5]} intensity={0.8} />
                </>
            )}
            {lighting === LightingMode.FLAT && (
                <ambientLight intensity={1.5} />
            )}

            <group position={[-7.5, 0, 6.5]}> 
                 {activeDataset && showSurface && (
                    <SurfaceMesh 
                        dataset={activeDataset} 
                        lighting={lighting} 
                        clipLowGray={clipLowGray} 
                        viewStyle={isAnimating ? ViewStyle.FLAT : viewStyle} 
                        colormap={colormap}
                        onHover={setHoverData}
                        opacity={isAnimating ? surfaceOpacity : 1.0}
                    />
                 )}
                 {activeDataset && showBars && (
                    <>
                        <BarsMesh 
                            dataset={activeDataset} 
                            clipLowGray={clipLowGray} 
                            colormap={colormap}
                            onHover={setHoverData}
                            animationState={animationState}
                            opacity={isAnimating ? barsOpacity : 1.0}
                        />
                        <Gray255Line dataset={activeDataset} visible={showLine} />
                    </>
                 )}
                 {activeDataset && showTable && (
                     <TableValues dataset={activeDataset} opacity={tableOpacity} />
                 )}

                 {/* Tooltip */}
                 {hoverData && (
                     <Html position={[hoverData.x, hoverData.y + 0.5, hoverData.z]} style={{ pointerEvents: 'none' }}>
                         <div className="bg-slate-800 text-white p-2 rounded shadow-lg border border-slate-600 text-xs whitespace-nowrap">
                             <div><span className="text-slate-400">Nits:</span> {hoverData.nits.toFixed(1)}</div>
                             <div><span className="text-slate-400">SVM:</span> {hoverData.svm.toFixed(2)}</div>
                             <div><span className="text-slate-400">Gray:</span> {Math.round(hoverData.gray)}</div>
                         </div>
                     </Html>
                 )}

                 {viewStyle === ViewStyle.FLAT ? (
                    <>
                        {activeDataset && <ContourLabels dataset={activeDataset} opacity={isAnimating ? contourOpacity : 1.0} />}
                        <FlatAxes 
                            width={activeDataset ? getLogNits(Math.max(...activeDataset.matrix.headerNits)) * 5 : 15} 
                            showNits={!isAnimating}
                        />
                        <ColorBar colormap={colormap} />
                        <PlotBorder width={activeDataset ? getLogNits(Math.max(...activeDataset.matrix.headerNits)) * 5 : 15} />
                    </>
                 ) : (
                    <>
                         {/* X Axis Labels */}
                         {showXAxis && (
                             viewStyle === ViewStyle.BARS && activeDataset ? (
                                 // Ordinal Axis for Bars
                                 <>
                                    {activeDataset.matrix.headerNits.map((nits, i) => {
                                       const cols = activeDataset.matrix.cols.length;
                                       const maxNits = Math.max(...activeDataset.matrix.headerNits);
                                       const totalWidth = getLogNits(maxNits) * 5;
                                       const step = totalWidth / Math.max(cols, 1);
                                       
                                       // Dynamic stride to prevent overlap
                                       // Assume each label needs ~0.8 units space?
                                       // Or simply limit to ~20 labels max
                                       const stride = Math.ceil(cols / 20);
                                       if (i % stride !== 0) return null;

                                       return (
                                           <Text 
                                               key={i}
                                               position={[(cols - 1 - i) * step, 0.1, 0.2]} 
                                                rotation={flatRotation}
                                                fontSize={0.4}
                                                color="white"
                                                anchorX="center"
                                                anchorY="top"
                                            >
                                                {Math.round(nits)}
                                            </Text>
                                        );
                                    })}
                                    <Text 
                                       position={[activeDataset ? getLogNits(Math.max(...activeDataset.matrix.headerNits)) * 5 : 15, 0.1, 0.2]} 
                                       rotation={flatRotation}
                                       fontSize={0.4} 
                                       color="white"
                                       anchorX="left"
                                   >
                                       Nits
                                   </Text>
                                 </>
                             ) : (
                                 // Metric Log Axis for Surface
                                 <>
                                    {xTicks.map(nits => (
                                         <Text 
                                            key={nits}
                                            position={[getLogNits(nits) * 5, 0.1, 0.2]} 
                                            rotation={flatRotation}
                                            fontSize={0.5}
                                            color="white"
                                            anchorX="center"
                                            anchorY="top"
                                         >
                                            {nits}
                                         </Text>
                                     ))}
                                     <Text 
                                        position={[15, 0.1, 0.2]} 
                                        rotation={flatRotation}
                                        fontSize={0.4} 
                                        color="white"
                                        anchorX="left"
                                    >
                                        Nits (Log)
                                    </Text>
                                 </>
                             )
                         )}

                         {/* Z Axis Labels (Shared) */}
                         {[0, 64, 128, 192, 255].map(g => {
                             if (isAnimating && g < visibleGrayThreshold) return null;
                             
                             const z = -g * 0.05;
                             return (
                                <Text 
                                    key={g}
                                    position={[-0.3, 0.1, z]} 
                                    rotation={flatRotation}
                                    fontSize={0.5} 
                                    color="white"
                                    anchorX="right"
                                >
                                    {g}
                                </Text>
                             );
                         })}
                         
                         <Text 
                            position={[-0.8, 0.1, zOffset / 2]} 
                            rotation={[ -Math.PI / 2, 0, Math.PI / 2]}
                            fontSize={0.4} 
                            color="white"
                            anchorX="center"
                            anchorY="bottom"
                         >
                            Gray Level
                         </Text>
                    </>
                 )}
            </group>
        </>
    );
}

const ZoomControl: React.FC<{ visible: boolean }> = ({ visible }) => {
    const { camera } = useThree();
    const controls = useThree((state) => state.controls) as any;
    const [sliderValue, setSliderValue] = useState(50);
    const isDragging = useRef(false);

    // Configuration
    const MIN_DIST = 2;
    const MAX_DIST = 80;

    // Sync slider with actual camera distance (Mouse Wheel support)
    useFrame(() => {
        if (controls && !isDragging.current && camera) {
            const dist = camera.position.distanceTo(controls.target);
            // Map Distance to Slider (0-100)
            // Slider 100 = Close (MIN_DIST)
            // Slider 0 = Far (MAX_DIST)
            const val = 100 - ((dist - MIN_DIST) / (MAX_DIST - MIN_DIST)) * 100;
            setSliderValue(Math.max(0, Math.min(100, val)));
        }
    });

    const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = parseFloat(e.target.value);
        setSliderValue(val);
        
        if (controls && camera) {
            // Calculate target distance
            const targetDist = MAX_DIST - (val / 100) * (MAX_DIST - MIN_DIST);
            
            // Move camera along the current view vector
            const direction = new THREE.Vector3().subVectors(camera.position, controls.target).normalize();
            
            // Safety check for NaN
            if (!direction.x && !direction.y && !direction.z) return;

            const newPos = controls.target.clone().add(direction.multiplyScalar(targetDist));
            camera.position.copy(newPos);
            controls.update();
        }
    };

    if (!visible) return null;

    return (
        <Html fullscreen style={{ pointerEvents: 'none' }}>
            <div className="absolute left-6 top-1/2 -translate-y-1/2 h-64 w-12 bg-slate-900/90 backdrop-blur-md rounded-2xl border border-slate-600/50 flex flex-col items-center py-4 shadow-2xl pointer-events-auto transition-opacity hover:bg-slate-900">
                <style>{`
                    input[type=range]::-webkit-slider-thumb {
                        -webkit-appearance: none;
                        height: 16px;
                        width: 16px;
                        border-radius: 50%;
                        background: #ffffff;
                        cursor: pointer;
                        box-shadow: 0 0 10px rgba(0,0,0,0.5);
                        margin-top: -6px;
                    }
                    input[type=range]::-webkit-slider-runnable-track {
                        width: 100%;
                        height: 4px;
                        cursor: pointer;
                        background: rgba(255,255,255,0.2);
                        border-radius: 2px;
                    }
                `}</style>
                
                <div className="text-white/60 text-[10px] font-bold mb-2 tracking-wider">ZOOM</div>
                
                <div className="flex-1 w-full flex items-center justify-center relative">
                    <input 
                        type="range" 
                        min="0" 
                        max="100" 
                        step="0.1"
                        value={sliderValue}
                        onChange={handleSliderChange}
                        onPointerDown={() => { isDragging.current = true; }}
                        onPointerUp={() => { isDragging.current = false; }}
                        className="appearance-none bg-transparent h-4 w-48 outline-none -rotate-90 origin-center"
                    />
                </div>
                
                <div className="text-white/60 text-[10px] font-mono mt-2">{Math.round(sliderValue)}%</div>
            </div>
        </Html>
    );
};

const Visualizer3D: React.FC<{
    datasets: Dataset[];
    activeDatasetId: string | null;
    viewStyle: ViewStyle;
    cameraMode: CameraMode;
    lighting: LightingMode;
    clipLowGray: boolean;
    colormap: ColormapType;
    isAnimating?: boolean;
    onAnimationEnd?: () => void;
}> = (props) => {
  const controlsRef = useRef<any>(null);

  useEffect(() => {
    if (!controlsRef.current) return;

    if (props.cameraMode === CameraMode.HEATMAP) {
        // Smooth transition to Top-Down
        // Preserve current distance to avoid zoom jump
        const dist = controlsRef.current.object.position.distanceTo(controlsRef.current.target);

        controlsRef.current.setPolarAngle(1e-5); // Avoid singularity
        controlsRef.current.setAzimuthalAngle(0); 
        controlsRef.current.target.set(0, 0, 0);

        // Force camera position to maintain distance from (0,0,0)
        controlsRef.current.object.position.set(0, dist, 0);

    } else {
         // We only set initial view if not animating
         if (!props.isAnimating) {
            // Standard ISO
             controlsRef.current.setPolarAngle(Math.PI / 4); 
             controlsRef.current.setAzimuthalAngle(Math.PI / 4);
         }
    }
    controlsRef.current.update();
  }, [props.cameraMode, props.isAnimating]);

  return (
    <div className="w-full h-full bg-gray-900 relative">
      <Canvas>
        <PerspectiveCamera makeDefault position={[10, 15, 20]} fov={50} />
        
        <OrbitControls 
            ref={controlsRef}
            makeDefault
            enableRotate={true} 
            maxPolarAngle={Math.PI / 2}
            enableDamping={true} 
        />
        
        <SceneContent 
            {...props} 
            isAnimating={props.isAnimating || false} 
            onAnimationEnd={props.onAnimationEnd || (() => {})}
        />
        <ZoomControl visible={!props.isAnimating} />
      </Canvas>
    </div>
  );
};

export default Visualizer3D;
