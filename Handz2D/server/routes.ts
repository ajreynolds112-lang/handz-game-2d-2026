import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { insertFighterSchema, insertFightResultSchema } from "@shared/schema";
import { z } from "zod";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";

const updateFighterSchema = z.object({
  name: z.string().optional(),
  firstName: z.string().optional(),
  nickname: z.string().optional(),
  lastName: z.string().optional(),
  archetype: z.string().optional(),
  level: z.number().int().min(1).optional(),
  xp: z.number().int().min(0).optional(),
  wins: z.number().int().min(0).optional(),
  losses: z.number().int().min(0).optional(),
  draws: z.number().int().min(0).optional(),
  knockouts: z.number().int().min(0).optional(),
  skillPoints: z.object({
    power: z.number(),
    speed: z.number(),
    defense: z.number(),
    stamina: z.number(),
    focus: z.number().optional(),
  }).optional(),
  availableStatPoints: z.number().int().min(0).optional(),
  careerBoutIndex: z.number().int().min(0).optional(),
  careerDifficulty: z.string().optional(),
  roundLengthMins: z.number().int().min(1).max(3).optional(),
  careerStats: z.object({
    totalPunchesThrown: z.number(),
    totalPunchesLanded: z.number(),
    totalKnockdownsGiven: z.number(),
    totalKnockdownsTaken: z.number(),
    totalBlocksMade: z.number(),
    totalDodges: z.number(),
    totalDamageDealt: z.number(),
    totalDamageReceived: z.number(),
    totalRoundsWon: z.number(),
    totalRoundsLost: z.number(),
    lifetimeXp: z.number(),
  }).optional(),
  skinColor: z.string().optional(),
  gearColors: z.object({
    gloves: z.string(),
    gloveTape: z.string(),
    trunks: z.string(),
    shoes: z.string(),
  }).optional(),
  trainingBonuses: z.object({
    weightLifting: z.number(),
    heavyBag: z.number(),
    sparring: z.number().optional(),
    nextFightBuffs: z.object({
      doubleCrit: z.boolean().optional(),
      moveSpeedBoost: z.boolean().optional(),
      doubleStun: z.boolean().optional(),
      extraWhiff: z.boolean().optional(),
    }).optional(),
    postFightXpBoost: z.number().optional(),
  }).optional(),
  careerRosterState: z.any().optional(),
});

const MAX_SAVE_SLOTS = 3;

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/fighters", async (_req, res) => {
    const fighters = await storage.getFighters();
    res.json(fighters);
  });

  app.get("/api/fighters/:id", async (req, res) => {
    const fighter = await storage.getFighter(req.params.id);
    if (!fighter) return res.status(404).json({ error: "Fighter not found" });
    res.json(fighter);
  });

  app.post("/api/fighters", async (req, res) => {
    const existing = await storage.getFighters();
    if (existing.length >= MAX_SAVE_SLOTS) {
      return res.status(400).json({ error: `Maximum of ${MAX_SAVE_SLOTS} save slots allowed` });
    }
    const parsed = insertFighterSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const fighter = await storage.createFighter(parsed.data);
    res.status(201).json(fighter);
  });

  app.patch("/api/fighters/:id", async (req, res) => {
    const parsed = updateFighterSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const fighter = await storage.updateFighter(req.params.id, parsed.data);
    if (!fighter) return res.status(404).json({ error: "Fighter not found" });
    res.json(fighter);
  });

  app.delete("/api/fighters/:id", async (req, res) => {
    await storage.deleteFighter(req.params.id);
    res.status(204).send();
  });

  app.post("/api/fight-results", async (req, res) => {
    const parsed = insertFightResultSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const result = await storage.createFightResult(parsed.data);
    res.status(201).json(result);
  });

  app.get("/api/fight-results/:fighterId", async (req, res) => {
    const results = await storage.getFightResults(req.params.fighterId);
    res.json(results);
  });

  app.get("/api/download-source", (_req, res) => {
    try {
      const projectRoot = path.resolve(process.cwd());
      const tmpZip = path.join("/tmp", `handz_source_${Date.now()}.tar.gz`);
      const excludes = [
        "--exclude=node_modules",
        "--exclude=.git",
        "--exclude=dist",
        "--exclude=.cache",
        "--exclude=.local",
        "--exclude=.agents",
        "--exclude=.config",
        "--exclude=attached_assets",
      ].join(" ");
      execSync(`tar czf ${tmpZip} ${excludes} -C ${path.dirname(projectRoot)} ${path.basename(projectRoot)}`, { timeout: 30000 });
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", "attachment; filename=handz_source.tar.gz");
      const stream = fs.createReadStream(tmpZip);
      stream.pipe(res);
      stream.on("end", () => {
        try { fs.unlinkSync(tmpZip); } catch {}
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to generate source archive" });
    }
  });

  return httpServer;
}
