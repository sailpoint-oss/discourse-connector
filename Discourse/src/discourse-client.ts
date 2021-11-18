import { ConnectorError } from "@sailpoint/connector-sdk"
import axios, { AxiosInstance } from "axios"
import { User } from "./model/user"
import { Group } from "./model/group"
import { GroupListResponse } from "./model/group-list-response"
import { GroupResponse } from "./model/group-response"
import { GroupMembers } from "./model/group-members"
import { UserEmail } from "./model/user-email"
import { UserUpdateResponse } from "./model/user-update-response"
import { UserUpdate } from "./model/user-update"
import cryptoRandomString from 'crypto-random-string'

let FormData = require("form-data")

/**
 * DiscourseClient is the client that communicates with Discourse APIs.
 */
export class DiscourseClient {
    private readonly apiKey?: string
    private readonly apiUsername?: string
    private readonly baseUrl?: string
    private readonly primaryGroup?: string
    httpClient: AxiosInstance

    constructor(config: any) {
        // Fetch necessary properties from config.
        this.apiKey = config?.apiKey
        if (this.apiKey == null) {
            throw new ConnectorError('apiKey must be provided from config')
        }

        this.apiUsername = config?.apiUsername
        if (this.apiUsername == null) {
            throw new ConnectorError('apiUsername must be provided from config')
        }

        this.baseUrl = config?.baseUrl
        if (this.baseUrl == null) {
            throw new ConnectorError('baseUrl must be provided from config')
        }

        this.primaryGroup = config?.primaryGroup
        if (this.primaryGroup == null) {
            throw new ConnectorError('primaryGroup must be provided from config')
        }

        this.httpClient = axios.create({
            baseURL: this.baseUrl,
            headers: {
                'Api-Key': this.apiKey,
                'Api-Username': this.apiUsername
            }
        })
    }

    /**
     * Test connection by listing users from the Discourse instance.  
     * This will make sure the apiKey has the correct access.
     * @returns empty struct if response is 2XX
     */
    async testConnection(): Promise<any> {
        await this.httpClient.get<User[]>('/admin/users/list/staff.json')
        return {}
    }

    /**
     * Create a user.
     * @param user the user to be created.
     * @returns the user.
     */
    async createUser(user: User): Promise<User> {
        const response = await this.httpClient.post<any>('/users.json', {
            name: user.username, // name doesn't work in discourse, so just use username
            email: user.email,
            password: cryptoRandomString({length: 20, type: 'base64'}),
            username: user.username,
            active: true,
            approved: true
        }).catch(error => {
            throw new ConnectorError(`Failed to create user ${user.username}`)
        })

        if (user.groups != null) {
            await Promise.all(user.groups.map(group => this.addUserToGroup(group.id!, user.username!)))
        }

        if (user.title != null) {
            await this.updateUser(user.username!, user)
        }

        const createdUser = await this.getUser(response.data.user_id)

        return createdUser
    }

    async getUsers(): Promise<User[]> {
        // First, get the members of the group.  This will return a subset of the fields we need to complete a user.
        const groupMembers = await this.getGroupMembers(this.primaryGroup!)

        // Get the full user representation
        let users = await Promise.all(groupMembers.map(member => this.getUser(member.id!.toString())))

        // Emails aren't included in the above call.  Need to get each user's email address from a different endpoint.
        const emails = await Promise.all(groupMembers.map(member => this.getUserEmailAddress(member.username!)))

        // Add each email address to the full user representation
        for (let i = 0; i < groupMembers.length; i++) {
            users[i].email = emails[i]
        }

        return users
    }

    private async getGroupMembers(groupname: string): Promise<User[]> {
        let offset = 0
        let total = 1 // Set total to 1 until we get the actual total from the first call
        let limit = 5
        let members: User[] = []

        while (offset < total) {
            const response = await this.httpClient.get<GroupMembers>(`/groups/${groupname}/members.json`, {
                params: {
                    offset: offset,
                    limit: limit
                }
            }).catch(error => {
                throw new ConnectorError(`Failed to retrieve members for group ${groupname}`)
            })

            members = members.concat(response.data.members!);
            total = response.data.meta!.total
            offset += limit
        }

        return members
    }

    private async getUserEmailAddress(username: string): Promise<string> {
        const response = await this.httpClient.get<UserEmail>(`/u/${username}/emails.json`).catch(error => {
            throw new ConnectorError(`Failed to retrieve email for user ${username}`)
        })

        return response.data.email!
    }

    private async addUserToGroup(groupId: number, username: string): Promise<boolean> {
        const response = await this.httpClient.put<any>(`/groups/${groupId}/members.json`, {
            usernames: username
        }).catch(error => {
            if (error.response.status !== 422) {
                throw new ConnectorError(error)
            }
        })

        return true
    }


    /**
	 * update a user by username.
	 * @param username the username of the user.
     * @param user the user data to be updated
	 * @returns the updated user.
	 */
	async updateUser(username: string, user: User): Promise<User> {
		let userUpdate = UserUpdate.fromUser(user)
        let data = new FormData()
        for (let key in userUpdate) {
            if ((userUpdate as any)[key] != null) {
                data.append(key, (userUpdate as any)[key])
            }
        }

		let response = await this.httpClient.put<UserUpdateResponse>(`/u/${username}.json`, userUpdate)
        if (response.data.user == null){
			throw new ConnectorError('Failed to update user.')
		}

		return response.data.user
	}

    /**
     * Retrieve a single user by identity.
     * @param identity the numeric ID of the user represented as a string.
     * @returns the agent.
     */
    async getUser(identity: string): Promise<User> {
        const userResponse = await this.httpClient.get<User>(`/admin/users/${identity}.json`).catch(error => {
            throw new ConnectorError(`Failed to retrieve user ${identity}`)
        })

        let user = null
        user = userResponse.data
        user.email = await this.getUserEmailAddress(user.username!)
        return user
    }

    /**
     * List groups with pagination
     * @returns a list of groups.
     */
    async getGroups(): Promise<Group[]> {
        let page: number = 0
        let hasMorePages: boolean = true
        let groups: Group[] = []

        while (hasMorePages) {
            const response = await this.httpClient.get<GroupListResponse>('/groups.json', {
                params: {
                    page: page
                }
            }).catch(error => {
                throw new ConnectorError('Failed to retrieve list of groups')
            })

            groups = groups.concat(response.data.groups!);
            response.data.groups!.length > 0 ? page += 1 : hasMorePages = false
        }

        return groups
    }

    /**
     * Get a single group by ID.  The ID is the name of the group not the numeric ID.
     * @param name the name of the group
     * @returns a single group.
     */
    async getGroup(name: string): Promise<Group> {
        const response = await this.httpClient.get<GroupResponse>(`/groups/${name}.json`).catch(error => {
            throw new ConnectorError(`Failed to retrieve the ${name} group.`)
        })

        return response.data.group!
    }
}