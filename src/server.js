// const problems = require('./problems.json');
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { exec } from 'child_process';
import fs from "fs";
import path from 'path';
import { createClient } from 'redis';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Problem from './models/problem.model.js';

import { dirname } from 'path';
import { fileURLToPath } from 'url';

// Define __dirname manually
const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config();
const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 5000;


// Connect to MongoDB
mongoose.connect(process.env.DBURL, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.error("MongoDB Connection Error:", err));

// Connect to Redis
const redisClient = createClient({
    url: process.env.UPSTASH_REDIS_URL,
    socket: {
        tls: true, // Required for Upstash
        rejectUnauthorized: false
    }
});
redisClient.on('error', (err) => console.error('Redis Client Error', err));
await redisClient.connect();

// Handle Redis events
redisClient.on("error", (err) => console.error("Redis Error:", err));
redisClient.on("connect", () => console.log("Connected to Redis"));
redisClient.on("ready", () => console.log("Redis Ready to Use"));
redisClient.on("end", () => console.log("Redis Connection Closed"));

// API to get problems
app.get('/problems', async (req, res) => {
    try {
        // Check Redis Cache First
        let cachedProblems = await redisClient.get("problems");

        if (cachedProblems) {
            console.log("Serving from Redis Cache");
            return res.json({
                statusResponse: "200",
                status: "success",
                problem: JSON.parse(cachedProblems),
            });
        }

        // Fetch from MongoDB if not cached
        const problems = await Problem.find();
        if (problems.length === 0) {
            return res.status(404).json({ error: "No Questions Found" });
        }

        // Store the result in Redis with an expiration time
        await redisClient.setEx("problems", 60 * 60 * 3, JSON.stringify(problems)); // 3 hours cache

        console.log("Fetched from Database");
        return res.json({
            statusResponse: "200",
            status: "success",
            problem: problems,
        });

    } catch (error) {
        res.status(500).json({ error: "Database Error", details: error.message });
    }
});

// API to get a single problem by ID
app.get('/problems/:id', async (req, res) => {
    try {
        const problemId = req.params.id;

        // Check if the problem exists in Redis
        const cachedProblem = await redisClient.get(`problem:${problemId}`);
        if (cachedProblem) {
            console.log("Serving from Redis Cache");
            return res.json(JSON.parse(cachedProblem));
        }

        // Fetch from MongoDB if not cached
        const problem = await Problem.findById(problemId);
        if (!problem) return res.status(404).json({ error: "Problem not found" });

        await redisClient.setEx(`problem:${problemId}`, 3600, JSON.stringify(problem)); // Cache for 1 hour
        console.log("Fetched from Database");
        res.json(problem);
    } catch (error) {
        res.status(500).json({ error: "Database Error", details: error.message });
    }
});

app.post('/submit', async (req, res) => {
    try {
        const { language, code, problemId } = req.body;

        // Check if the problem exists in Redis
        let problem = await redisClient.get(`problem:${problemId}`);
        if (!problem) {
            problem = await Problem.findOne({ _id: problemId });
            if (!problem) {
                return res.status(404).json({ error: "Problem not found" });
            }
            await redisClient.setEx(`problem:${problemId}`, 60 * 60 * 3, JSON.stringify(problem)); // Cache for 3 hours
        } else {
            problem = JSON.parse(problem);
        }

        // Ensure temp directory exists
        const tempDir = path.join(__dirname, "submissions");
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }

        // Define file path
        const fileExt = language === 'c' ? 'c' : 'cpp';
        const fileName = `solution.${fileExt}`;
        const filePath = path.join(tempDir, fileName);

        // Write code to file
        fs.writeFileSync(filePath, code, { encoding: 'utf8' });

        // Compile the code
        const outputFilePath = path.join(tempDir, "solution.out");
        const compileCmd = language === 'c' 
            ? `gcc ${filePath} -o ${outputFilePath}` 
            : `g++ ${filePath} -o ${outputFilePath}`;

        exec(compileCmd, (compileErr, _, compileStderr) => {
            if (compileErr) {
                return res.json({ error: "Compilation Error", details: compileStderr });
            }

            let results = [];
            let completed = 0;

            // Execute for each test case
            problem.testCases.forEach((test, index) => {
                const childProcess = exec(outputFilePath, (execErr, stdout, stderr) => {
                    if (execErr || stderr) {
                        results.push({ test: index + 1, passed: false, output: stderr || execErr.message });
                    } else {
                        results.push({ test: index + 1, passed: stdout.trim() === test.expected, output: stdout.trim() });
                    }
                    completed++;

                    // Respond after all test cases run
                    if (completed === problem.testCases.length) {
                        res.json({ results });

                        // Cleanup files after execution
                        fs.unlinkSync(filePath);
                        fs.unlinkSync(outputFilePath);
                    }
                });

                // Send input to the program
                childProcess.stdin.write(test.input);
                childProcess.stdin.end();
            });
        });
    } catch (error) {
        return res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

app.listen(5000, '0.0.0.0', () => {
    console.log("Server running on port 5000");
});
