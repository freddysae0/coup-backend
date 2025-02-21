FROM node:23-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY . .

# Install dependencies
RUN npm install



# Expose port (adjust if needed)
EXPOSE 3000

# Start the application
CMD ["npm", "run" , "dev"]
